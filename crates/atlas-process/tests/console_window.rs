//! Windows console-window leak detector.
//!
//! A child of a GUI process that is a console application gets a fresh
//! console — and on Windows 11 with "let Windows decide" as the default
//! terminal, a Windows Terminal window — unless it is created with
//! `CREATE_NO_WINDOW`. That is the bug behind "a terminal window appears on
//! every Atlas Agent tool call".
//!
//! `cargo test` runs inside a console, where children simply inherit it and
//! the leak is invisible. So each test first `FreeConsole()`s this process,
//! making it console-less exactly like the shipped app, then spawns a child
//! and watches for a visible console/terminal window. Integration tests get
//! their own process, so freeing the console here affects nothing else.
#![cfg(windows)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use atlas_process::NoWindow;

#[link(name = "kernel32")]
extern "system" {
    fn FreeConsole() -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn EnumWindows(cb: extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
}

static HITS: AtomicUsize = AtomicUsize::new(0);
static TARGET_PID: AtomicUsize = AtomicUsize::new(0);

/// Counts visible console-host windows (legacy conhost or Windows Terminal)
/// belonging to `pid` — or to any process when `pid` is 0.
extern "system" fn count_console_windows(hwnd: isize, _: isize) -> i32 {
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        if class != "ConsoleWindowClass" && class != "CASCADIA_HOSTING_WINDOW_CLASS" {
            return 1;
        }
        let want = TARGET_PID.load(Ordering::SeqCst) as u32;
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        // Windows Terminal hosts the window in its own process, so a pid
        // match is only meaningful for legacy conhost; count both.
        if want == 0 || pid == want || class == "CASCADIA_HOSTING_WINDOW_CLASS" {
            HITS.fetch_add(1, Ordering::SeqCst);
        }
    }
    1
}

fn visible_console_windows() -> usize {
    HITS.store(0, Ordering::SeqCst);
    unsafe {
        EnumWindows(count_console_windows, 0);
    }
    HITS.load(Ordering::SeqCst)
}

/// Spawn `cmd.exe /c <script>` from a console-less parent and report the
/// peak number of NEW visible console windows while it runs.
fn spawn_and_watch(no_window: bool) -> usize {
    unsafe {
        FreeConsole();
    }
    let baseline = visible_console_windows();
    // ~1.2s of life so a 50ms poll cannot miss a window that flashes.
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.args(["/c", "ping -n 2 127.0.0.1 >nul"]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if no_window {
        cmd.no_window();
    }
    let mut child = cmd.spawn().expect("spawn cmd.exe");
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut peak = 0usize;
    while Instant::now() < deadline {
        let now = visible_console_windows().saturating_sub(baseline);
        peak = peak.max(now);
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    peak
}

/// The gate: a console child created through `atlas_process` must never put
/// a window on screen, even from a parent that has no console of its own.
#[test]
fn no_window_helper_keeps_a_console_child_windowless() {
    assert_eq!(spawn_and_watch(true), 0, "a flagged child opened a console window");
}

/// The failure mode this crate exists for, kept as a runnable demonstration
/// rather than a gate: from a console-less parent a plain `Command` DOES open
/// a console window (Windows Terminal or conhost). Ignored by default because
/// it deliberately flashes a window and depends on the desktop; run with
/// `cargo test -p atlas-process --test console_window -- --ignored`.
#[test]
#[ignore = "demonstrates the leak by opening a real console window"]
fn a_plain_command_from_a_windowless_parent_opens_a_console_window() {
    assert!(
        spawn_and_watch(false) >= 1,
        "expected the unflagged child to open a console window"
    );
}
