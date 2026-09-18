//! The session-start log line, observed through a real subscriber.
//!
//! Its own test binary on purpose: a scoped subscriber only sees callsites
//! whose interest was computed while it was installed, and tests on other
//! threads of a shared binary race that computation — the line then goes
//! nowhere and the test fails for a reason unrelated to the code.

mod support;

use std::sync::Arc;

use support::custom;
use support::spawning::manager_advertising_capabilities;

/// Collects everything a scoped subscriber writes.
#[derive(Clone, Default)]
struct CapturedLog(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl CapturedLog {
    fn lines_mentioning(&self, needle: &str) -> Vec<String> {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .filter(|line| line.contains(needle))
            .map(str::to_string)
            .collect()
    }
}

/// Opens one session on an agent that answers `initialize` with `caps`, and
/// returns the session-start lines written while it did. `None` when there is
/// no python to run the agent with.
async fn session_start_lines(
    log: &CapturedLog,
    tag: &str,
    caps: serde_json::Value,
) -> Option<Vec<String>> {
    let (manager, pid_file) = manager_advertising_capabilities(tag, caps)?;
    let before = log.lines_mentioning("agent session started").len();
    let thread = manager
        .new_session(custom("fake-agent"), vec![std::env::temp_dir()])
        .await
        .expect("a session opens on the real agent");
    let lines = log.lines_mentioning("agent session started").split_off(before);
    manager.shutdown();
    drop(thread);
    let _ = std::fs::remove_file(&pid_file);
    Some(lines)
}

/// The open fact in the spec — which installed adapters can receive the
/// memory tool server — is answered from the log of a real run: every session
/// start says which agent it is and whether it advertised HTTP MCP.
///
/// One test, both cases in sequence, and `current_thread`: the subscriber is
/// scoped to this thread, the line is written on the caller's own task, and a
/// second test would run on another thread (see the module comment).
#[tokio::test(flavor = "current_thread")]
async fn each_session_start_logs_the_agent_and_its_http_mcp_support() {
    let log = CapturedLog::default();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .with_writer({
            let log = log.clone();
            move || log.clone()
        })
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let Some(advertised) = session_start_lines(
        &log,
        "http-mcp-log-on",
        serde_json::json!({ "mcpCapabilities": { "http": true } }),
    )
    .await
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    assert_eq!(advertised.len(), 1, "exactly one line per session start: {advertised:?}");
    let line = &advertised[0];
    assert!(line.contains("agent=fake-agent"), "names the agent: {line}");
    assert!(line.contains("http_mcp=true"), "states its HTTP MCP support: {line}");

    let omitted = session_start_lines(&log, "http-mcp-log-off", serde_json::json!({}))
        .await
        .expect("python3 was there a moment ago");
    assert_eq!(omitted.len(), 1, "exactly one line per session start: {omitted:?}");
    let line = &omitted[0];
    assert!(line.contains("agent=fake-agent"), "names the agent: {line}");
    assert!(line.contains("http_mcp=false"), "states its HTTP MCP support: {line}");
}
