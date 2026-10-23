//! External editors: which ones are installed, and opening a file or a folder
//! in one, at a line and column where the editor can take them.
//!
//! Detection looks where each editor actually puts its launcher: a CLI on
//! `PATH` (boot has already merged the login shell's `PATH` into ours, see
//! `atlas_agent_servers::host_env`), then the app bundle or install folder,
//! then JetBrains Toolbox's script folder. It walks the disk, so it runs on
//! the blocking pool, once per launch; the result is cached until the
//! Settings page asks for a refresh.
//!
//! Opening never goes through a shell. The target is one argument in an argv
//! array, the editor id must name an editor detection found, and the path must
//! be absolute (so it can never be read as a flag) and exist.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

/// The id of "the app the OS opens this path with". Always detected.
pub const SYSTEM_EDITOR_ID: &str = "system";

/// How an editor takes a position on its command line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchStyle {
    /// The VS Code family: `--goto path:line:col`.
    Goto,
    /// `path:line:col` as one argument (Zed, Sublime Text).
    Suffix,
    /// JetBrains IDEs: `--line L --column C path`, the column counted from 0.
    JetBrains,
    /// Xcode's `xed -l L path`; it takes no column.
    Xed,
    /// The system's app for the file. No position.
    System,
}

/// Where inside a macOS app bundle the launcher lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacLauncher {
    /// `Contents/Resources/app/bin/<command>` (VS Code and its forks).
    ElectronBin,
    /// `Contents/MacOS/cli`.
    ZedCli,
    /// `Contents/SharedSupport/bin/subl`.
    Sublime,
    /// No CLI inside the bundle: `open -na <bundle> --args …`.
    JetBrains,
    /// `/usr/bin/xed`, once Xcode itself is installed.
    Xcode,
}

struct EditorDef {
    id: &'static str,
    label: &'static str,
    /// CLI names, in preference order.
    commands: &'static [&'static str],
    style: LaunchStyle,
    /// macOS bundle names (without `.app`). JetBrains Toolbox appends a
    /// version (`IntelliJ IDEA 2026.1.app`), which is matched too.
    mac_apps: &'static [&'static str],
    mac_launcher: MacLauncher,
    /// Windows install folder names under `%LOCALAPPDATA%\Programs` and
    /// `Program Files` (prefix-matched for JetBrains, which appends a version).
    win_dirs: &'static [&'static str],
}

impl EditorDef {
    fn is_jetbrains(&self) -> bool {
        self.style == LaunchStyle::JetBrains
    }
}

macro_rules! jetbrains {
    ($id:literal, $label:literal, $cmd:literal, [$($app:literal),+]) => {
        EditorDef {
            id: $id,
            label: $label,
            commands: &[$cmd],
            style: LaunchStyle::JetBrains,
            mac_apps: &[$($app),+],
            mac_launcher: MacLauncher::JetBrains,
            win_dirs: &[$($app),+],
        }
    };
}

/// Every editor Atlas knows, in the order a default is picked from: the first
/// one installed is what "Open in editor" uses until the user chooses.
const EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "cursor",
        label: "Cursor",
        commands: &["cursor"],
        style: LaunchStyle::Goto,
        mac_apps: &["Cursor"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["cursor", "Cursor"],
    },
    EditorDef {
        id: "vscode",
        label: "VS Code",
        commands: &["code"],
        style: LaunchStyle::Goto,
        mac_apps: &["Visual Studio Code"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["Microsoft VS Code"],
    },
    EditorDef {
        id: "zed",
        label: "Zed",
        commands: &["zed", "zeditor"],
        style: LaunchStyle::Suffix,
        mac_apps: &["Zed"],
        mac_launcher: MacLauncher::ZedCli,
        win_dirs: &["Zed"],
    },
    EditorDef {
        id: "windsurf",
        label: "Windsurf",
        commands: &["windsurf"],
        style: LaunchStyle::Goto,
        mac_apps: &["Windsurf"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["Windsurf"],
    },
    EditorDef {
        id: "vscode-insiders",
        label: "VS Code Insiders",
        commands: &["code-insiders"],
        style: LaunchStyle::Goto,
        mac_apps: &["Visual Studio Code - Insiders"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["Microsoft VS Code Insiders"],
    },
    EditorDef {
        id: "vscodium",
        label: "VSCodium",
        commands: &["codium"],
        style: LaunchStyle::Goto,
        mac_apps: &["VSCodium"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["VSCodium"],
    },
    EditorDef {
        id: "sublime",
        label: "Sublime Text",
        commands: &["subl"],
        style: LaunchStyle::Suffix,
        mac_apps: &["Sublime Text"],
        mac_launcher: MacLauncher::Sublime,
        win_dirs: &["Sublime Text", "Sublime Text 3"],
    },
    jetbrains!(
        "idea",
        "IntelliJ IDEA",
        "idea",
        [
            "IntelliJ IDEA",
            "IntelliJ IDEA Ultimate",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Community Edition"
        ]
    ),
    jetbrains!("webstorm", "WebStorm", "webstorm", ["WebStorm"]),
    jetbrains!(
        "pycharm",
        "PyCharm",
        "pycharm",
        ["PyCharm", "PyCharm CE", "PyCharm Community Edition"]
    ),
    jetbrains!("phpstorm", "PhpStorm", "phpstorm", ["PhpStorm"]),
    jetbrains!("goland", "GoLand", "goland", ["GoLand"]),
    jetbrains!("rubymine", "RubyMine", "rubymine", ["RubyMine"]),
    jetbrains!("clion", "CLion", "clion", ["CLion"]),
    jetbrains!("rider", "Rider", "rider", ["Rider", "JetBrains Rider"]),
    jetbrains!("rustrover", "RustRover", "rustrover", ["RustRover"]),
    jetbrains!("datagrip", "DataGrip", "datagrip", ["DataGrip"]),
    EditorDef {
        id: "xcode",
        label: "Xcode",
        commands: &[],
        style: LaunchStyle::Xed,
        mac_apps: &["Xcode"],
        mac_launcher: MacLauncher::Xcode,
        win_dirs: &[],
    },
];

/// One detected editor, as the frontend sees it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    pub id: String,
    pub label: String,
}

/// How a detected editor is started.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launcher {
    /// Run `program` with `base_args`, then the target.
    Program {
        program: PathBuf,
        base_args: Vec<String>,
    },
    /// A macOS bundle with no CLI: `open -na <bundle> --args <target…>`.
    MacBundle(PathBuf),
    /// Hand the path to the OS (`tauri_plugin_opener::open_path`).
    System,
}

#[derive(Debug, Clone)]
struct Detected {
    id: &'static str,
    label: &'static str,
    style: LaunchStyle,
    launcher: Launcher,
}

impl Detected {
    fn system() -> Self {
        Self {
            id: SYSTEM_EDITOR_ID,
            label: "System default",
            style: LaunchStyle::System,
            launcher: Launcher::System,
        }
    }

    fn public(&self) -> ExternalEditor {
        ExternalEditor {
            id: self.id.to_string(),
            label: self.label.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// What detection reads from the environment, gathered once so the search
/// itself is a function of its inputs.
struct HostEnv {
    path_var: Option<OsString>,
    home: Option<PathBuf>,
    local_app_data: Option<PathBuf>,
    program_files: Vec<PathBuf>,
    xdg_data_home: Option<PathBuf>,
}

impl HostEnv {
    fn current() -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        Self {
            path_var: var("PATH"),
            home: dirs::home_dir(),
            local_app_data: var("LOCALAPPDATA").map(PathBuf::from),
            program_files: ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
                .iter()
                .filter_map(|name| var(name).map(PathBuf::from))
                .collect(),
            xdg_data_home: var("XDG_DATA_HOME").map(PathBuf::from),
        }
    }
}

/// The filesystem questions detection asks, so a test can answer them.
trait Probe {
    fn is_executable(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    fn list_dir(&self, path: &Path) -> Vec<String>;
    fn on_path(&self, command: &str, path_var: &OsString) -> Option<PathBuf>;
}

struct RealProbe;

impl Probe for RealProbe {
    fn is_executable(&self, path: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        if !meta.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn list_dir(&self, path: &Path) -> Vec<String> {
        std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn on_path(&self, command: &str, path_var: &OsString) -> Option<PathBuf> {
        atlas_agent_store::detection::find_on_path(command, path_var)
    }
}

/// `IntelliJ IDEA 2026.1.4.app` for `IntelliJ IDEA`, but never `Visual Studio
/// Code - Insiders.app` for `Visual Studio Code`: the suffix must be a version.
fn is_versioned_bundle(entry: &str, name: &str) -> bool {
    let Some(rest) = entry
        .strip_prefix(name)
        .and_then(|r| r.strip_prefix(' '))
        .and_then(|r| r.strip_suffix(".app"))
    else {
        return false;
    };
    rest.starts_with(|c: char| c.is_ascii_digit())
        && rest.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn program(path: PathBuf) -> Launcher {
    Launcher::Program {
        program: path,
        base_args: Vec::new(),
    }
}

fn find_on_path(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    let path_var = env.path_var.as_ref()?;
    def.commands
        .iter()
        .find_map(|command| probe.on_path(command, path_var))
        .map(program)
}

fn resolve_mac(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    // OpenZFS installs a `zed` (its event daemon) on PATH; on a Mac the editor
    // bundle is the trustworthy one, so it is looked for first.
    let bundle_first = def.id == "zed";
    if !bundle_first && def.mac_launcher != MacLauncher::Xcode {
        if let Some(found) = find_on_path(def, env, probe) {
            return Some(found);
        }
    }
    if def.is_jetbrains() {
        if let Some(home) = &env.home {
            let scripts = home.join("Library/Application Support/JetBrains/Toolbox/scripts");
            for command in def.commands {
                let script = scripts.join(command);
                if probe.is_executable(&script) {
                    return Some(program(script));
                }
            }
        }
    }
    let roots = env
        .home
        .iter()
        .map(|h| h.join("Applications"))
        .chain(std::iter::once(PathBuf::from("/Applications")));
    for root in roots {
        let mut bundles: Vec<String> = def.mac_apps.iter().map(|n| format!("{n}.app")).collect();
        if def.is_jetbrains() {
            for entry in probe.list_dir(&root) {
                if def.mac_apps.iter().any(|n| is_versioned_bundle(&entry, n)) {
                    bundles.push(entry);
                }
            }
        }
        for bundle in bundles {
            let bundle = root.join(bundle);
            if !probe.is_dir(&bundle) {
                continue;
            }
            let contents = bundle.join("Contents");
            let launcher = match def.mac_launcher {
                MacLauncher::ElectronBin => def
                    .commands
                    .iter()
                    .map(|c| contents.join("Resources/app/bin").join(c))
                    .find(|p| probe.is_executable(p))
                    .map(program),
                MacLauncher::ZedCli => Some(contents.join("MacOS/cli"))
                    .filter(|p| probe.is_executable(p))
                    .map(program),
                MacLauncher::Sublime => Some(contents.join("SharedSupport/bin/subl"))
                    .filter(|p| probe.is_executable(p))
                    .map(program),
                MacLauncher::JetBrains => Some(Launcher::MacBundle(bundle.clone())),
                MacLauncher::Xcode => Some(PathBuf::from("/usr/bin/xed"))
                    .filter(|p| probe.is_executable(p))
                    .map(program),
            };
            if launcher.is_some() {
                return launcher;
            }
        }
    }
    if bundle_first {
        return find_on_path(def, env, probe);
    }
    None
}

fn resolve_windows(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    if let Some(found) = find_on_path(def, env, probe) {
        return Some(found);
    }
    let mut roots: Vec<PathBuf> = env
        .local_app_data
        .iter()
        .map(|d| d.join("Programs"))
        .collect();
    roots.extend(env.program_files.iter().cloned());
    let mut candidates = Vec::new();
    if def.is_jetbrains() {
        if let Some(local) = &env.local_app_data {
            for command in def.commands {
                candidates.push(
                    local
                        .join("JetBrains/Toolbox/scripts")
                        .join(format!("{command}.cmd")),
                );
            }
        }
        for dir in roots.iter().flat_map(|r| [r.clone(), r.join("JetBrains")]) {
            for entry in probe.list_dir(&dir) {
                let matches = def
                    .win_dirs
                    .iter()
                    .any(|n| entry == *n || entry.starts_with(&format!("{n} ")));
                if !matches {
                    continue;
                }
                for command in def.commands {
                    let bin = dir.join(&entry).join("bin");
                    candidates.push(bin.join(format!("{command}64.exe")));
                    candidates.push(bin.join(format!("{command}.exe")));
                }
            }
        }
    } else {
        for root in &roots {
            for name in def.win_dirs {
                let base = root.join(name);
                for command in def.commands {
                    candidates.push(base.join("bin").join(format!("{command}.cmd")));
                    candidates.push(
                        base.join("resources/app/bin")
                            .join(format!("{command}.cmd")),
                    );
                    candidates.push(base.join("bin").join(format!("{command}.exe")));
                    candidates.push(base.join(format!("{command}.exe")));
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| probe.is_executable(p))
        .map(program)
}

fn resolve_linux(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    if let Some(found) = find_on_path(def, env, probe) {
        return Some(found);
    }
    let mut dirs: Vec<PathBuf> = env.home.iter().map(|h| h.join(".local/bin")).collect();
    dirs.extend(["/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    if def.is_jetbrains() {
        let data = env
            .xdg_data_home
            .clone()
            .or_else(|| env.home.as_ref().map(|h| h.join(".local/share")));
        if let Some(data) = data {
            dirs.push(data.join("JetBrains/Toolbox/scripts"));
        }
    }
    dirs.iter()
        .flat_map(|dir| def.commands.iter().map(move |c| dir.join(c)))
        .find(|p| probe.is_executable(p))
        .map(program)
}

fn resolve(
    def: &EditorDef,
    platform: Platform,
    env: &HostEnv,
    probe: &dyn Probe,
) -> Option<Launcher> {
    match platform {
        Platform::Mac => resolve_mac(def, env, probe),
        Platform::Windows if def.mac_launcher == MacLauncher::Xcode => None,
        Platform::Windows => resolve_windows(def, env, probe),
        Platform::Linux if def.mac_launcher == MacLauncher::Xcode => None,
        Platform::Linux => resolve_linux(def, env, probe),
    }
}

/// Every installed editor, in `EDITORS` order, then the system default.
fn detect(platform: Platform, env: &HostEnv, probe: &dyn Probe) -> Vec<Detected> {
    let mut found: Vec<Detected> = EDITORS
        .iter()
        .filter_map(|def| {
            resolve(def, platform, env, probe).map(|launcher| Detected {
                id: def.id,
                label: def.label,
                style: def.style,
                launcher,
            })
        })
        .collect();
    found.push(Detected::system());
    found
}

/// Detection runs at most once per launch unless refreshed. A tokio mutex,
/// held across the blocking probe, so a second caller during the first probe
/// waits for its result instead of probing again.
static DETECTED: Mutex<Option<Arc<Vec<Detected>>>> = Mutex::const_new(None);

async fn detected(refresh: bool) -> Result<Arc<Vec<Detected>>, String> {
    let mut cache = DETECTED.lock().await;
    if let (Some(list), false) = (cache.as_ref(), refresh) {
        return Ok(list.clone());
    }
    let list = tokio::task::spawn_blocking(|| {
        Arc::new(detect(Platform::current(), &HostEnv::current(), &RealProbe))
    })
    .await
    .map_err(|e| format!("editor detection failed: {e}"))?;
    *cache = Some(list.clone());
    Ok(list)
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// A 1-based position in a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Position {
    line: u32,
    column: Option<u32>,
}

/// The target arguments for `style`: the path, with the position spelled the
/// way that editor reads it.
fn target_args(style: LaunchStyle, path: &Path, position: Option<Position>) -> Vec<OsString> {
    let Some(Position { line, column }) = position.filter(|p| p.line > 0) else {
        return vec![path.as_os_str().to_owned()];
    };
    let column = column.filter(|c| *c > 0);
    let suffixed = || {
        let mut target = path.as_os_str().to_owned();
        target.push(format!(":{line}"));
        if let Some(column) = column {
            target.push(format!(":{column}"));
        }
        target
    };
    match style {
        LaunchStyle::Goto => vec!["--goto".into(), suffixed()],
        LaunchStyle::Suffix => vec![suffixed()],
        LaunchStyle::JetBrains => {
            let mut args: Vec<OsString> = vec!["--line".into(), line.to_string().into()];
            if let Some(column) = column {
                args.push("--column".into());
                args.push((column - 1).to_string().into());
            }
            args.push(path.as_os_str().to_owned());
            args
        }
        LaunchStyle::Xed => vec![
            "-l".into(),
            line.to_string().into(),
            path.as_os_str().to_owned(),
        ],
        LaunchStyle::System => vec![path.as_os_str().to_owned()],
    }
}

/// The program and argv that open `path` in `editor`, or `None` for the
/// system default, which goes through the opener plugin instead.
fn command_for(
    editor: &Detected,
    path: &Path,
    position: Option<Position>,
) -> Option<(PathBuf, Vec<OsString>)> {
    let target = target_args(editor.style, path, position);
    match &editor.launcher {
        Launcher::System => None,
        Launcher::Program { program, base_args } => {
            let mut args: Vec<OsString> = base_args.iter().map(OsString::from).collect();
            args.extend(target);
            Some((program.clone(), args))
        }
        Launcher::MacBundle(bundle) => {
            let mut args: Vec<OsString> =
                vec!["-na".into(), bundle.as_os_str().to_owned(), "--args".into()];
            args.extend(target);
            Some((PathBuf::from("/usr/bin/open"), args))
        }
    }
}

fn find_editor<'a>(list: &'a [Detected], id: &str) -> Result<&'a Detected, String> {
    if let Some(found) = list.iter().find(|d| d.id == id) {
        return Ok(found);
    }
    match EDITORS.iter().find(|def| def.id == id) {
        Some(def) => Err(format!("{} isn't installed", def.label)),
        None => Err(format!("Unknown editor: {id}")),
    }
}

/// The path as given, if it is one an editor may be handed: absolute (so it
/// can never be mistaken for a flag) and free of control characters, which no
/// real path holds and a Windows `.cmd` shim would re-parse.
fn checked_target(path: &str) -> Result<PathBuf, String> {
    if path.chars().any(char::is_control) {
        return Err("The path contains a control character".to_string());
    }
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(format!("Not an absolute path: {path}"));
    }
    Ok(target)
}

/// `"` closes the quoting a Windows batch shim (`code.cmd`) relies on; Rust
/// refuses some such arguments itself, but saying so plainly is kinder.
fn check_batch_safe(program: &Path, args: &[OsString]) -> Result<(), String> {
    let is_batch = program
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if is_batch && args.iter().any(|a| a.to_string_lossy().contains('"')) {
        return Err("This editor can't open a path containing a double quote".to_string());
    }
    Ok(())
}

fn spawn_detached(program: &Path, args: &[OsString]) -> Result<(), String> {
    check_batch_safe(program, args)?;
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a `.cmd` shim would otherwise flash a console.
        command.creation_flags(0x0800_0000);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("Couldn't start {}: {e}", program.display()))?;
    // The CLIs hand off to the running app and exit; reap them so they don't
    // linger as zombies for the rest of the session. Windows has no zombies.
    #[cfg(unix)]
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    #[cfg(not(unix))]
    let _ = child;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The installed editors, in default-preference order, ending with the system
/// default. Cached after the first call; `refresh` probes again.
#[tauri::command]
pub async fn external_editors_detect(refresh: Option<bool>) -> Result<Vec<ExternalEditor>, String> {
    let list = detected(refresh.unwrap_or(false)).await?;
    Ok(list.iter().map(Detected::public).collect())
}

/// Open `path` (a file or a folder) in the detected editor `editor`, at
/// `line`/`column` (1-based) where the editor takes them.
#[tauri::command]
pub async fn external_editor_open(
    editor: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let target = checked_target(&path)?;
    let list = detected(false).await?;
    let chosen = find_editor(&list, &editor)?.clone();
    tokio::task::spawn_blocking(move || {
        if !target.exists() {
            return Err(format!("No such file or folder: {}", target.display()));
        }
        let position = line
            .filter(|_| target.is_file())
            .map(|line| Position { line, column });
        match command_for(&chosen, &target, position) {
            Some((program, args)) => spawn_detached(&program, &args),
            None => tauri_plugin_opener::open_path(&target, None::<&str>)
                .map_err(|e| format!("Couldn't open {}: {e}", target.display())),
        }
    })
    .await
    .map_err(|e| format!("opening the editor failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn def(id: &str) -> &'static EditorDef {
        EDITORS.iter().find(|d| d.id == id).expect("a known editor")
    }

    fn detected_program(id: &str, program: &str) -> Detected {
        let d = def(id);
        Detected {
            id: d.id,
            label: d.label,
            style: d.style,
            launcher: Launcher::Program {
                program: PathBuf::from(program),
                base_args: Vec::new(),
            },
        }
    }

    fn argv(editor: &Detected, path: &str, position: Option<Position>) -> (String, Vec<String>) {
        let (program, args) = command_for(editor, Path::new(path), position).expect("a program");
        (
            program.to_string_lossy().into_owned(),
            args.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
        )
    }

    const SPACED: &str = "/Users/me/My Project/src/main file.rs";
    const AT: Option<Position> = Some(Position {
        line: 12,
        column: Some(5),
    });
    const LINE_ONLY: Option<Position> = Some(Position {
        line: 12,
        column: None,
    });

    #[test]
    fn the_vscode_family_takes_goto_with_line_and_column() {
        for id in [
            "vscode",
            "cursor",
            "windsurf",
            "vscode-insiders",
            "vscodium",
        ] {
            let editor = detected_program(id, "/usr/local/bin/code");
            assert_eq!(
                argv(&editor, SPACED, AT).1,
                ["--goto", &format!("{SPACED}:12:5")],
                "{id}"
            );
            assert_eq!(
                argv(&editor, SPACED, LINE_ONLY).1,
                ["--goto", &format!("{SPACED}:12")]
            );
            assert_eq!(
                argv(&editor, SPACED, None).1,
                [SPACED],
                "no position, no --goto"
            );
        }
    }

    #[test]
    fn zed_and_sublime_take_a_suffixed_path() {
        for id in ["zed", "sublime"] {
            let editor = detected_program(id, "/usr/local/bin/zed");
            assert_eq!(
                argv(&editor, SPACED, AT).1,
                [format!("{SPACED}:12:5")],
                "{id}"
            );
            assert_eq!(argv(&editor, SPACED, LINE_ONLY).1, [format!("{SPACED}:12")]);
            assert_eq!(argv(&editor, SPACED, None).1, [SPACED]);
        }
    }

    #[test]
    fn jetbrains_takes_line_and_a_zero_based_column_before_the_path() {
        let editor = detected_program("idea", "/usr/local/bin/idea");
        assert_eq!(
            argv(&editor, SPACED, AT).1,
            ["--line", "12", "--column", "4", SPACED]
        );
        assert_eq!(argv(&editor, SPACED, LINE_ONLY).1, ["--line", "12", SPACED]);
        assert_eq!(argv(&editor, SPACED, None).1, [SPACED]);
    }

    #[test]
    fn a_jetbrains_bundle_goes_through_open_with_its_args_after_args() {
        let d = def("webstorm");
        let editor = Detected {
            id: d.id,
            label: d.label,
            style: d.style,
            launcher: Launcher::MacBundle(PathBuf::from("/Applications/WebStorm.app")),
        };
        let (program, args) = argv(&editor, SPACED, AT);
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(
            args,
            [
                "-na",
                "/Applications/WebStorm.app",
                "--args",
                "--line",
                "12",
                "--column",
                "4",
                SPACED
            ]
        );
    }

    #[test]
    fn xcode_takes_a_line_but_no_column() {
        let editor = detected_program("xcode", "/usr/bin/xed");
        assert_eq!(argv(&editor, SPACED, AT).1, ["-l", "12", SPACED]);
    }

    #[test]
    fn base_args_come_before_the_target() {
        let mut editor = detected_program("cursor", "/usr/local/bin/cursor");
        editor.launcher = Launcher::Program {
            program: PathBuf::from("/usr/local/bin/cursor"),
            base_args: vec!["--reuse-window".into()],
        };
        assert_eq!(
            argv(&editor, SPACED, AT).1,
            ["--reuse-window", "--goto", &format!("{SPACED}:12:5")]
        );
    }

    #[test]
    fn a_zero_line_or_column_is_no_position() {
        let editor = detected_program("vscode", "/usr/local/bin/code");
        let zero_line = Some(Position {
            line: 0,
            column: Some(3),
        });
        assert_eq!(argv(&editor, SPACED, zero_line).1, [SPACED]);
        let zero_col = Some(Position {
            line: 3,
            column: Some(0),
        });
        assert_eq!(
            argv(&editor, SPACED, zero_col).1,
            ["--goto", &format!("{SPACED}:3")]
        );
    }

    #[test]
    fn the_system_default_is_not_a_spawned_program() {
        assert!(command_for(&Detected::system(), Path::new(SPACED), AT).is_none());
    }

    #[test]
    fn unknown_and_uninstalled_ids_are_rejected() {
        let list = vec![
            detected_program("zed", "/usr/local/bin/zed"),
            Detected::system(),
        ];
        assert_eq!(find_editor(&list, "zed").unwrap().id, "zed");
        assert_eq!(find_editor(&list, "system").unwrap().id, "system");
        assert_eq!(
            find_editor(&list, "rm -rf /").unwrap_err(),
            "Unknown editor: rm -rf /"
        );
        assert_eq!(
            find_editor(&list, "vscode").unwrap_err(),
            "VS Code isn't installed"
        );
    }

    #[test]
    fn only_absolute_paths_without_control_characters_are_targets() {
        assert!(checked_target(SPACED).is_ok());
        assert!(
            checked_target("--help").is_err(),
            "a flag-looking path is relative"
        );
        assert!(checked_target("src/main.rs").is_err());
        assert!(checked_target("/tmp/a\nb").is_err());
    }

    #[test]
    fn a_batch_shim_refuses_a_double_quote() {
        let args = vec![OsString::from("C:\\a\"b")];
        assert!(check_batch_safe(Path::new("C:\\x\\code.cmd"), &args).is_err());
        assert!(check_batch_safe(Path::new("C:\\x\\zed.exe"), &args).is_ok());
    }

    #[test]
    fn versioned_bundles_match_only_a_version_suffix() {
        assert!(is_versioned_bundle(
            "IntelliJ IDEA 2026.1.4.app",
            "IntelliJ IDEA"
        ));
        assert!(!is_versioned_bundle(
            "IntelliJ IDEA CE.app",
            "IntelliJ IDEA"
        ));
        assert!(!is_versioned_bundle(
            "Visual Studio Code - Insiders.app",
            "Visual Studio Code"
        ));
    }

    #[test]
    fn editor_ids_are_unique_and_never_the_system_id() {
        let mut seen = HashSet::new();
        for d in EDITORS {
            assert!(seen.insert(d.id), "duplicate id {}", d.id);
            assert_ne!(d.id, SYSTEM_EDITOR_ID);
        }
    }

    /// A pretend disk: executables, directories and PATH hits.
    #[derive(Default)]
    struct FakeProbe {
        executables: HashSet<PathBuf>,
        dirs: HashMap<PathBuf, Vec<String>>,
        path_hits: HashMap<String, PathBuf>,
    }

    impl Probe for FakeProbe {
        fn is_executable(&self, path: &Path) -> bool {
            self.executables.contains(path)
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.contains_key(path)
        }
        fn list_dir(&self, path: &Path) -> Vec<String> {
            self.dirs.get(path).cloned().unwrap_or_default()
        }
        fn on_path(&self, command: &str, _: &OsString) -> Option<PathBuf> {
            self.path_hits.get(command).cloned()
        }
    }

    fn mac_env() -> HostEnv {
        HostEnv {
            path_var: Some("/usr/bin".into()),
            home: Some("/Users/me".into()),
            local_app_data: None,
            program_files: Vec::new(),
            xdg_data_home: None,
        }
    }

    #[test]
    fn mac_detection_finds_bundles_and_keeps_preference_order() {
        let mut probe = FakeProbe::default();
        let code_app = PathBuf::from("/Applications/Visual Studio Code.app");
        probe.dirs.insert(code_app.clone(), vec![]);
        probe
            .executables
            .insert(code_app.join("Contents/Resources/app/bin/code"));
        // Toolbox's versioned bundle, found by listing the folder.
        let idea_app = PathBuf::from("/Users/me/Applications/IntelliJ IDEA 2026.1.app");
        probe.dirs.insert(
            "/Users/me/Applications".into(),
            vec!["IntelliJ IDEA 2026.1.app".into()],
        );
        probe.dirs.insert(idea_app.clone(), vec![]);
        // A ZFS `zed` on PATH loses to the Zed bundle.
        probe
            .path_hits
            .insert("zed".into(), "/usr/local/zfs/bin/zed".into());
        let zed_app = PathBuf::from("/Applications/Zed.app");
        probe.dirs.insert(zed_app.clone(), vec![]);
        probe.executables.insert(zed_app.join("Contents/MacOS/cli"));

        let found = detect(Platform::Mac, &mac_env(), &probe);
        let ids: Vec<_> = found.iter().map(|d| d.id).collect();
        assert_eq!(ids, ["vscode", "zed", "idea", "system"]);
        assert_eq!(
            found[1].launcher,
            program(zed_app.join("Contents/MacOS/cli"))
        );
        assert_eq!(found[2].launcher, Launcher::MacBundle(idea_app));
    }

    #[test]
    fn xcode_needs_its_bundle_and_is_mac_only() {
        let mut probe = FakeProbe::default();
        probe.dirs.insert("/Applications/Xcode.app".into(), vec![]);
        probe.executables.insert("/usr/bin/xed".into());
        let ids = |p| -> Vec<&str> { detect(p, &mac_env(), &probe).iter().map(|d| d.id).collect() };
        assert_eq!(ids(Platform::Mac), ["xcode", "system"]);
        assert_eq!(ids(Platform::Linux), ["system"]);
    }

    #[test]
    fn linux_detection_reads_path_then_toolbox_scripts() {
        let mut probe = FakeProbe::default();
        probe
            .path_hits
            .insert("subl".into(), "/usr/bin/subl".into());
        probe
            .executables
            .insert("/home/me/.local/share/JetBrains/Toolbox/scripts/pycharm".into());
        let env = HostEnv {
            path_var: Some("/usr/bin".into()),
            home: Some("/home/me".into()),
            local_app_data: None,
            program_files: Vec::new(),
            xdg_data_home: None,
        };
        let ids: Vec<_> = detect(Platform::Linux, &env, &probe)
            .iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, ["sublime", "pycharm", "system"]);
    }
}
