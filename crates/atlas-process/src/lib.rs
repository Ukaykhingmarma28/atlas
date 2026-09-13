//! One rule for every child Atlas spawns: **no console window**.
//!
//! Atlas is a GUI process. On Windows a child of a GUI process that is not
//! itself a GUI program gets a fresh console (a `conhost.exe` and a window
//! that flashes on screen) unless it is created with `CREATE_NO_WINDOW`.
//! Opening one project in the release build spawned 30 `git` processes in
//! 40 seconds and put 25 console windows on the user's screen. Every spawn
//! site routes through [`NoWindow::no_window`], which is a no-op off Windows.
//!
//! This is only for children whose stdio Atlas owns (piped or null). A child
//! that is meant to have a console — the integrated terminal's shell — runs
//! under ConPTY and never comes through here.

/// Windows `CREATE_NO_WINDOW` process creation flag.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window a Windows GUI process would otherwise give a
/// child. Chainable, like the builder methods on both `Command` types.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

/// A `std` command that already carries [`NoWindow::no_window`].
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.no_window();
    cmd
}

/// A `tokio` command that already carries [`NoWindow::no_window`].
pub fn async_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.no_window();
    cmd
}
