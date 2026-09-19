//! In-app auto-updater (Windows MSI) — the Windows counterpart of
//! `updater_macos.rs`, with the same **background staged** design:
//!
//! 1. On startup (and every few hours) a non-blocking check queries PostHog
//!    remote config for `{version, uri}` ([`check_in_background`]), where the
//!    URI comes from the `uri_win_intel` key — the one x64 MSI that
//!    `bun run build:app:win` produces (see `telemetry::update_uri_flag`).
//! 2. If newer, the MSI is **downloaded in the background** (shared engine in
//!    `updater_download.rs`) to `<app_data>/updates/Atlas-<ver>.msi` — the app
//!    stays fully usable, only a titlebar arc shows.
//! 3. The file is verified ([`verify_installer`]) and recorded as staged. The
//!    running install is untouched.
//! 4. The user is notified non-blockingly ("Restart to update"). **Restart
//!    now** hands off to a detached helper ([`spawn_apply_helper`]) that waits
//!    for this process to exit, runs `msiexec /i <msi> /passive /norestart` —
//!    a WiX major upgrade over the existing install; Windows shows its UAC
//!    consent prompt because the package is per-machine — and relaunches Atlas
//!    from its install location. **Later** does the same at the next natural
//!    quit, without the relaunch ([`apply_on_exit`]).
//!
//! Everything is `auto_update`-gated and honors an "ignored version", and the
//! `atlas:update-*` event contract is the one documented in `updater_macos.rs`.
//!
//! ## Trust anchor
//!
//! The macOS updater refuses anything not signed by Atlas's Apple Team ID. The
//! Windows MSI is not Authenticode-signed yet, so there is no equivalent
//! anchor: the download URL must be HTTPS, the file must be a real Windows
//! Installer package, and the UAC prompt shows the user what is about to be
//! installed. Set [`EXPECTED_SIGNER`] once release MSIs are signed and a valid
//! signature from that subject becomes mandatory.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::download::{download_to, emit_progress};
use super::{UpdateStatus, UpdaterSnapshot};
use crate::telemetry::{RemoteUpdateConfig, TelemetryClient};

/// The running app's version (compile-time). Compared against the remote value.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Authenticode signer subject (e.g. `CN=Atlas, O=…, C=…`) the MSI must carry a
/// valid signature from. `None` while release MSIs are unsigned — see the
/// module docs. When set, [`verify_installer`] rejects anything else.
const EXPECTED_SIGNER: Option<&str> = None;

/// How often to re-check for updates while the app runs.
const RECHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);

/// Helper script written next to the installer and run detached at apply time.
const APPLY_SCRIPT_NAME: &str = "apply-update.ps1";

/// Every Windows Installer package is an OLE compound document.
const OLE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Persisted record of a staged update (`<app_data>/updates/staging.json`).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Staging {
    version: String,
    /// Path to the downloaded + verified MSI once ready.
    staged_installer: Option<String>,
    /// The MSI has been downloaded and verified — ready to install.
    ready: bool,
    /// The apply helper has been launched (on restart/quit). Used at startup
    /// to detect a completed update and clean up — or, if the running version
    /// is still the old one, an install the user cancelled at the UAC prompt.
    #[serde(default)]
    applied: bool,
}

/// In-memory updater state (managed).
#[derive(Default)]
pub struct UpdaterState {
    /// Latest `{version, uri}` from a check.
    pending: Mutex<Option<RemoteUpdateConfig>>,
    /// Guards against concurrent background downloads.
    downloading: AtomicBool,
    /// Version currently staged + ready (mirror of the on-disk manifest).
    ready: Mutex<Option<String>>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ── Paths / manifest ─────────────────────────────────────────────────────────

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("updates"))
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(updates_dir(app)?.join("staging.json"))
}

fn load_manifest(app: &AppHandle) -> Option<Staging> {
    let path = manifest_path(app).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_manifest(app: &AppHandle, m: &Staging) -> Result<(), String> {
    let dir = updates_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("updates dir: {e}"))?;
    let raw = serde_json::to_string_pretty(m).map_err(|e| format!("serialize manifest: {e}"))?;
    std::fs::write(dir.join("staging.json"), raw).map_err(|e| format!("write manifest: {e}"))
}

/// The staged MSI recorded in `m`, if it is still on disk.
fn staged_installer(m: &Staging) -> Option<PathBuf> {
    let p = PathBuf::from(m.staged_installer.as_ref()?);
    p.is_file().then_some(p)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Semver "is `remote` strictly newer than `current`?". False on parse failure.
fn is_newer(remote: &str, current: &str) -> bool {
    match (
        semver::Version::parse(remote.trim()),
        semver::Version::parse(current.trim()),
    ) {
        (Ok(r), Ok(c)) => r > c,
        _ => false,
    }
}

fn read_settings(app: &AppHandle) -> (bool, Option<String>) {
    let settings = crate::state::atlas_config::read(app);
    (settings.auto_update, settings.updater_ignored_version)
}

async fn fetch_remote(app: &AppHandle) -> Option<RemoteUpdateConfig> {
    let tel = app.state::<Arc<TelemetryClient>>().inner().clone();
    tel.fetch_remote_config().await
}

fn emit_checking(app: &AppHandle, checking: bool) {
    let _ = app.emit("atlas:update-checking", serde_json::json!({ "checking": checking }));
}

// ── Check ────────────────────────────────────────────────────────────────────

/// Non-blocking check. Honors `auto_update` + ignored version. If a newer
/// version is found, kicks off the background download+stage (or re-notifies
/// "ready" if it's already staged). Emits `atlas:update-available`.
pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (auto, ignored) = read_settings(&app);
        if !auto {
            return;
        }
        emit_checking(&app, true);
        let cfg = fetch_remote(&app).await;
        emit_checking(&app, false);
        let Some(cfg) = cfg else { return };
        if !is_newer(&cfg.version, CURRENT_VERSION) {
            return;
        }
        if ignored.as_deref() == Some(cfg.version.as_str()) {
            return;
        }
        maybe_start_update(&app, cfg).await;
    });
}

/// Given a newer remote config, either re-notify a matching staged update or
/// start the background download.
async fn maybe_start_update(app: &AppHandle, cfg: RemoteUpdateConfig) {
    *app.state::<UpdaterState>().pending.lock() = Some(cfg.clone());

    // Already downloaded + verified for this exact version → just notify.
    if let Some(m) = load_manifest(app) {
        if m.ready && m.version == cfg.version && staged_installer(&m).is_some() {
            *app.state::<UpdaterState>().ready.lock() = Some(cfg.version.clone());
            let _ = app.emit("atlas:update-ready", serde_json::json!({ "version": cfg.version }));
            return;
        }
    }

    let _ = app.emit(
        "atlas:update-available",
        serde_json::json!({ "version": cfg.version, "currentVersion": CURRENT_VERSION }),
    );
    download_and_stage(app.clone(), cfg).await;
}

/// Manual "Check for updates" — bypasses the auto_update / ignored gates (an
/// explicit user action). Triggers the background download when newer.
pub(super) async fn update_check_now(app: AppHandle) -> Result<UpdateStatus, String> {
    emit_checking(&app, true);
    let cfg = fetch_remote(&app).await;
    emit_checking(&app, false);
    let available = cfg
        .as_ref()
        .map(|c| is_newer(&c.version, CURRENT_VERSION))
        .unwrap_or(false);
    let version = cfg.as_ref().map(|c| c.version.clone());
    if let Some(cfg) = cfg.filter(|_| available) {
        maybe_start_update(&app, cfg).await;
    }
    Ok(UpdateStatus {
        available,
        version,
        current_version: CURRENT_VERSION.to_string(),
    })
}

/// Current updater state for UI hydration on mount.
pub(super) fn update_state(app: AppHandle, state: State<'_, UpdaterState>) -> UpdaterSnapshot {
    if let Some(v) = state.ready.lock().clone() {
        return UpdaterSnapshot {
            phase: "ready".into(),
            version: Some(v),
            current_version: CURRENT_VERSION.to_string(),
        };
    }
    if state.downloading.load(Ordering::SeqCst) {
        let v = state.pending.lock().as_ref().map(|c| c.version.clone());
        return UpdaterSnapshot {
            phase: "downloading".into(),
            version: v,
            current_version: CURRENT_VERSION.to_string(),
        };
    }
    // Fall back to the on-disk manifest (e.g. staged before this window mounted).
    if let Some(m) = load_manifest(&app) {
        if m.ready && is_newer(&m.version, CURRENT_VERSION) && staged_installer(&m).is_some() {
            return UpdaterSnapshot {
                phase: "ready".into(),
                version: Some(m.version),
                current_version: CURRENT_VERSION.to_string(),
            };
        }
    }
    UpdaterSnapshot {
        phase: "idle".into(),
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    }
}

/// Persist a "don't prompt for this version again" choice.
pub(super) async fn update_ignore(version: String, app: AppHandle) -> Result<(), String> {
    let patch = crate::state::SettingsPatch {
        updater_ignored_version: Some(Some(version)),
        ..Default::default()
    };
    // Off the async runtime thread — this touches the filesystem.
    let app_for_write = app.clone();
    let snapshot = tokio::task::spawn_blocking(move || crate::state::atlas_config::update(&app_for_write, patch))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    crate::commands::atlas_config::notify_settings_changed(&app, &snapshot.settings, snapshot.generation);
    Ok(())
}

// ── Download + stage ─────────────────────────────────────────────────────────

/// Orchestrate a background download → verify → stage. Single-flight via the
/// `downloading` guard. On success emits `atlas:update-ready`.
async fn download_and_stage(app: AppHandle, cfg: RemoteUpdateConfig) {
    if app
        .state::<UpdaterState>()
        .downloading
        .swap(true, Ordering::SeqCst)
    {
        return; // a download is already in flight
    }
    let result = do_download_and_stage(&app, &cfg).await;
    app.state::<UpdaterState>()
        .downloading
        .store(false, Ordering::SeqCst);

    match result {
        Ok(_) => {
            *app.state::<UpdaterState>().ready.lock() = Some(cfg.version.clone());
            let _ = app.emit("atlas:update-ready", serde_json::json!({ "version": cfg.version }));
        }
        Err(e) => {
            tracing::warn!(target: "atlas::updater", "download/stage failed: {e}");
            let _ = app.emit("atlas:update-error", serde_json::json!({ "message": e }));
        }
    }
}

async fn do_download_and_stage(app: &AppHandle, cfg: &RemoteUpdateConfig) -> Result<PathBuf, String> {
    let dir = updates_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("updates dir: {e}"))?;
    let msi = dir.join(format!("Atlas-{}.msi", cfg.version));
    let part = dir.join(format!("Atlas-{}.msi.part", cfg.version));

    // Already fully staged? short-circuit.
    if let Some(m) = load_manifest(app) {
        if m.ready && m.version == cfg.version {
            if let Some(p) = staged_installer(&m) {
                return Ok(p);
            }
        }
    }

    check_download_url(&cfg.uri)?;
    if !msi.exists() {
        download_to(app, &cfg.uri, &part, &msi, &cfg.version).await?;
    }

    emit_progress(app, &cfg.version, 0, 0, "verifying");
    let to_verify = msi.clone();
    let verified = tauri::async_runtime::spawn_blocking(move || verify_installer(&to_verify))
        .await
        .map_err(|e| format!("verify join: {e}"))?;
    if let Err(e) = verified {
        // Never leave a rejected package where a later run could pick it up.
        let _ = std::fs::remove_file(&msi);
        return Err(e);
    }

    save_manifest(
        app,
        &Staging {
            version: cfg.version.clone(),
            staged_installer: Some(msi.to_string_lossy().into_owned()),
            ready: true,
            applied: false,
        },
    )?;
    Ok(msi)
}

/// The installer URL comes from remote config, so insist on transport
/// security: HTTPS, or plain HTTP only to this machine (local test servers).
fn check_download_url(uri: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(uri).map_err(|e| format!("update URL: {e}"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err("update rejected: installer URL is not HTTPS".into()),
    }
}

/// Reject anything that is not a Windows Installer package, and — once
/// [`EXPECTED_SIGNER`] is set — anything without a valid Authenticode
/// signature from that subject.
fn verify_installer(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut head = [0u8; 8];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("read installer: {e}"))?;
    if head != OLE_MAGIC {
        return Err("update rejected: not a Windows Installer package".into());
    }
    if let Some(signer) = EXPECTED_SIGNER {
        verify_authenticode(path, signer)?;
    }
    Ok(())
}

/// `Get-AuthenticodeSignature` via PowerShell: status must be `Valid` and the
/// signer's subject must match exactly. The path travels in an environment
/// variable so no quoting of it happens on a command line.
fn verify_authenticode(path: &Path, signer: &str) -> Result<(), String> {
    const SCRIPT: &str = "$s = Get-AuthenticodeSignature -LiteralPath $env:ATLAS_UPDATE_MSI; \
                          Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject";
    let out = atlas_process::command(powershell_exe())
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("ATLAS_UPDATE_MSI", path)
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if !out.status.success() {
        return Err("update rejected: signature check failed to run".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines().map(str::trim);
    let status = lines.next().unwrap_or_default();
    let subject = lines.next().unwrap_or_default();
    if status != "Valid" {
        return Err("update rejected: code signature invalid".into());
    }
    if subject != signer {
        return Err("update rejected: unexpected signing publisher".into());
    }
    Ok(())
}

/// Windows PowerShell 5.1 ships with every supported Windows; resolve it by
/// absolute path so the app's own PATH is irrelevant.
fn powershell_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| {
            PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

// ── Apply (install) ──────────────────────────────────────────────────────────

/// "Restart now": launch the detached install helper and quit; it upgrades the
/// install once this process is gone and relaunches Atlas.
pub(super) async fn update_apply(app: AppHandle) -> Result<(), String> {
    let m = load_manifest(&app).ok_or("no update is staged")?;
    if !m.ready {
        return Err("update not ready yet".into());
    }
    let installer = staged_installer(&m).ok_or("staged update is missing")?;
    let relaunch = installed_exe(&app)?;

    if let Err(e) = spawn_apply_helper(&app, &installer, Some(&relaunch)) {
        let _ = app.emit("atlas:update-error", serde_json::json!({ "message": e }));
        return Err(e);
    }
    // Recorded before exiting so `apply_on_exit` doesn't launch a second
    // installer for the same package on the way out.
    save_manifest(
        &app,
        &Staging {
            applied: true,
            ..m
        },
    )?;
    app.exit(0);
    Ok(())
}

/// Apply a staged update at natural quit ("Later"). Best-effort, no relaunch —
/// the next launch is the new version. Skipped for ignored versions.
pub fn apply_on_exit(app: &AppHandle) {
    let Some(m) = load_manifest(app) else { return };
    if !m.ready || m.applied {
        return;
    }
    if !is_newer(&m.version, CURRENT_VERSION) {
        return;
    }
    let ignored = crate::state::atlas_config::read(app).updater_ignored_version;
    if ignored.as_deref() == Some(m.version.as_str()) {
        return;
    }
    let Some(installer) = staged_installer(&m) else { return };
    // Same guard as "Restart now": only upgrade an MSI-installed Atlas.
    if installed_exe(app).is_err() {
        return;
    }
    if spawn_apply_helper(app, &installer, None).is_ok() {
        let _ = save_manifest(
            app,
            &Staging {
                applied: true,
                ..m
            },
        );
    }
}

/// Startup housekeeping: if a staged update was applied (we're now running a
/// version >= the staged one), clean it up and toast. If the helper ran but
/// this is still the old version (the UAC prompt was declined, or the install
/// failed), re-arm the staged package so the user is offered it again. Call
/// before the first check.
pub fn init_on_startup(app: &AppHandle) {
    let Some(m) = load_manifest(app) else { return };
    // Running a version at or beyond the staged one → the staging is obsolete
    // (applied on the previous quit, or superseded by a manual install).
    if !is_newer(&m.version, CURRENT_VERSION) {
        if let Ok(dir) = updates_dir(app) {
            let _ = std::fs::remove_dir_all(&dir);
        }
        if m.applied {
            let _ = app.emit("atlas:update-applied", serde_json::json!({ "version": CURRENT_VERSION }));
        }
        return;
    }
    if m.applied {
        let _ = save_manifest(
            app,
            &Staging {
                applied: false,
                ..m
            },
        );
    }
}

/// Periodically re-check for updates while the app runs.
pub fn spawn_periodic(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(RECHECK_INTERVAL);
        interval.tick().await; // consume the immediate first tick (startup already checked)
        loop {
            interval.tick().await;
            check_in_background(&app);
        }
    });
}

/// The helper that performs the upgrade after this process exits. It is a
/// script rather than inline `-Command` text so every path is an ordinary
/// argument, and it logs to `apply.log` beside the installer for diagnosis.
fn apply_script() -> &'static str {
    r#"param(
    [Parameter(Mandatory = $true)][int]$ParentPid,
    [Parameter(Mandatory = $true)][string]$Installer,
    [string]$Relaunch = ""
)
$ErrorActionPreference = "Continue"
$log = Join-Path (Split-Path -Parent $Installer) "apply.log"
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Log "waiting for Atlas (pid $ParentPid) to exit"
try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction Stop } catch { Log "wait: $($_.Exception.Message)" }

Log "msiexec /i $Installer /passive /norestart"
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$Installer`"", "/passive", "/norestart") -Wait -PassThru
Log "msiexec exit code $($p.ExitCode)"

# 0 = installed, 3010 = installed and a reboot is pending; anything else
# (1602 = cancelled at the UAC prompt) leaves the old version in place.
if ($Relaunch -ne "" -and ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010)) {
    Log "relaunching $Relaunch"
    Start-Process -FilePath $Relaunch -WorkingDirectory (Split-Path -Parent $Relaunch)
}
"#
}

/// Write the helper next to the installer and start it detached (its own
/// hidden console, nothing inherited), so it outlives this process.
fn spawn_apply_helper(app: &AppHandle, installer: &Path, relaunch: Option<&Path>) -> Result<(), String> {
    let script = updates_dir(app)?.join(APPLY_SCRIPT_NAME);
    std::fs::write(&script, apply_script()).map_err(|e| format!("write apply helper: {e}"))?;

    let mut cmd = atlas_process::command(powershell_exe());
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
    ])
    .arg(&script)
    .arg("-ParentPid")
    .arg(std::process::id().to_string())
    .arg("-Installer")
    .arg(installer);
    if let Some(exe) = relaunch {
        cmd.arg("-Relaunch").arg(exe);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| format!("start apply helper: {e}"))
}

/// The `atlas.exe` the helper relaunches: the one in the MSI's install
/// location, which must also be where this process is running from. A build
/// run from a checkout (or a copied exe) errors here, as the macOS updater
/// does for a non-`.app` location — the MSI would upgrade the *installed*
/// Atlas while this one kept running the old code.
fn installed_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let product = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "Atlas".to_string());
    let install_dir = installed_location(&product)
        .ok_or("Atlas isn't installed from its MSI on this machine; download the installer manually")?;
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let running_dir = exe
        .parent()
        .ok_or_else(|| "could not resolve the running exe's directory".to_string())?;
    if !same_dir(running_dir, &install_dir) {
        return Err(format!(
            "running from a non-installed location ({}); update via the MSI",
            running_dir.display()
        ));
    }
    let name = exe
        .file_name()
        .ok_or_else(|| "could not resolve the running exe's name".to_string())?;
    Ok(install_dir.join(name))
}

/// `InstallLocation` of the Windows Installer uninstall entry whose
/// `DisplayName` is `product` — what the MSI's WiX template registers.
/// Per-machine (HKLM) first, then per-user (HKCU).
fn installed_location(product: &str) -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
        .into_iter()
        .filter_map(|hive| RegKey::predef(hive).open_subkey_with_flags(UNINSTALL, KEY_READ).ok())
        .find_map(|uninstall| {
            uninstall.enum_keys().flatten().find_map(|name| {
                let entry = uninstall.open_subkey_with_flags(&name, KEY_READ).ok()?;
                let display: String = entry.get_value("DisplayName").ok()?;
                if display != product {
                    return None;
                }
                let location: String = entry.get_value("InstallLocation").ok()?;
                let location = location.trim();
                (!location.is_empty()).then(|| PathBuf::from(location))
            })
        })
}

/// Same directory, ignoring case, trailing separators and `\\?\` prefixes.
fn same_dir(a: &Path, b: &Path) -> bool {
    fn key(p: &Path) -> String {
        let p = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        p.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    }
    key(a) == key(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_gate_is_strict_semver() {
        assert!(is_newer("0.3.4", "0.3.3"));
        assert!(!is_newer("0.3.3", "0.3.3"));
        assert!(!is_newer("0.3.2", "0.3.3"));
        assert!(!is_newer("latest", "0.3.3"));
    }

    #[test]
    fn installer_url_must_be_https_unless_loopback() {
        assert!(check_download_url("https://github.com/x/Atlas.msi").is_ok());
        assert!(check_download_url("http://127.0.0.1:8080/Atlas.msi").is_ok());
        assert!(check_download_url("http://localhost:8080/Atlas.msi").is_ok());
        assert!(check_download_url("http://example.com/Atlas.msi").is_err());
        assert!(check_download_url("file:///C:/Atlas.msi").is_err());
        assert!(check_download_url("not a url").is_err());
    }

    #[test]
    fn verify_rejects_anything_that_is_not_an_msi() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("Atlas.msi");
        std::fs::write(&fake, b"<html>not an installer</html>").unwrap();
        assert_eq!(
            verify_installer(&fake).unwrap_err(),
            "update rejected: not a Windows Installer package"
        );

        let short = dir.path().join("short.msi");
        std::fs::write(&short, b"\xD0\xCF").unwrap();
        assert!(verify_installer(&short).is_err());

        let real = dir.path().join("real.msi");
        let mut bytes = OLE_MAGIC.to_vec();
        bytes.extend_from_slice(&[0u8; 512]);
        std::fs::write(&real, bytes).unwrap();
        // Signature enforcement is off until `EXPECTED_SIGNER` is set.
        assert!(EXPECTED_SIGNER.is_none());
        assert!(verify_installer(&real).is_ok());
    }

    #[test]
    fn same_dir_ignores_case_and_trailing_separators() {
        let dir = tempfile::tempdir().unwrap();
        let upper = PathBuf::from(dir.path().to_string_lossy().to_uppercase());
        let mut trailing = dir.path().as_os_str().to_owned();
        trailing.push("\\");
        assert!(same_dir(dir.path(), &upper));
        assert!(same_dir(dir.path(), Path::new(&trailing)));
        assert!(!same_dir(dir.path(), &dir.path().join("sub")));
    }

    #[test]
    fn staged_installer_must_still_exist() {
        let dir = tempfile::tempdir().unwrap();
        let msi = dir.path().join("Atlas-9.9.9.msi");
        let m = Staging {
            version: "9.9.9".into(),
            staged_installer: Some(msi.to_string_lossy().into_owned()),
            ready: true,
            applied: false,
        };
        assert!(staged_installer(&m).is_none());
        std::fs::write(&msi, b"x").unwrap();
        assert_eq!(staged_installer(&m), Some(msi));
        assert!(staged_installer(&Staging::default()).is_none());
    }

    #[test]
    fn apply_script_upgrades_in_place_and_only_relaunches_on_success() {
        let s = apply_script();
        assert!(s.contains("Wait-Process -Id $ParentPid"));
        assert!(s.contains(r#""/i", "`"$Installer`"", "/passive", "/norestart""#));
        assert!(s.contains("$p.ExitCode -eq 0 -or $p.ExitCode -eq 3010"));
        assert!(s.contains("Start-Process -FilePath $Relaunch"));
    }

    #[test]
    fn manifest_round_trips_with_camel_case_keys() {
        let m = Staging {
            version: "0.3.4".into(),
            staged_installer: Some(r"C:\x\Atlas-0.3.4.msi".into()),
            ready: true,
            applied: false,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"stagedInstaller\""));
        let back: Staging = serde_json::from_str(&json).unwrap();
        assert_eq!(back.staged_installer, m.staged_installer);
        assert!(back.ready && !back.applied);
    }
}
