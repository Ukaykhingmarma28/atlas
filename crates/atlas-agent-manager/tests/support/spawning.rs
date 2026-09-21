//! A manager whose one installed agent is a real child process: a small
//! python script answering `initialize` and `session/new`, the same fixture
//! shape `atlas-agent-servers/tests/connect.rs` uses. Shared by the test
//! binaries that need the spawn-and-handshake path rather than a fake
//! connection.
//!
//! Every `session/new`, `session/load` and `session/resume` the agent receives
//! is appended, as its JSON params on one line, to [`requests_file`] — how a
//! test sees exactly what went over the wire.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::AgentId;
use atlas_agent_manager::AgentManager;
use atlas_agent_servers::{AgentServerCommand, ConnectOptions, ExternalAgentServer, SessionMcpServers};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::watch;

use super::{connect_options, wait_for};

/// Answers `initialize` and the session requests, then sits there. Writes its pid
/// first, so the test can ask the operating system whether it is still alive.
const FAKE_AGENT: &str = r#"
import sys, json, os, time
open(PID_FILE, "w").write(str(os.getpid()))
go_file = GO_FILE
if go_file:
    while not os.path.exists(go_file):
        time.sleep(0.01)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": 1,
            "agentCapabilities": json.loads(AGENT_CAPABILITIES),
            "authMethods": [],
            "agentInfo": {"name": "fake-agent", "version": "9.9.9"},
        }
    elif method in ("session/new", "session/load", "session/resume"):
        with open(PID_FILE + ".requests", "a") as log:
            log.write(json.dumps({"method": method, "params": msg.get("params")}) + "\n")
        params = msg.get("params") or {}
        if params.get("sessionId") == "missing":
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32002, "message": "no such session"}}) + "\n")
            sys.stdout.flush()
            continue
        result = {"sessionId": "session-1"} if method == "session/new" else {}
    else:
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
"#;

/// `python3` from `PATH`, else from the usual install locations; `None` means
/// the python-backed tests skip.
///
/// Except under CI, where a missing interpreter is a failure: a runner without
/// python3 would otherwise report these tests green having run none of them.
fn python() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("python3"))
            .find(|candidate| candidate.is_file())
    });
    let found = on_path.or_else(|| {
        [
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
    });
    if found.is_none() && std::env::var_os("CI").is_some_and(|ci| !ci.is_empty()) {
        panic!("python3 is not on PATH, and CI is set: these tests would skip rather than run");
    }
    found
}

/// Resolves the fake agent's command, the way the real store resolves an
/// installed agent's.
struct PythonResolver {
    python: PathBuf,
    pid_file: PathBuf,
    /// When set, the agent spawns and then waits for this file to exist before
    /// answering `initialize` — so the connect parks with a real child alive.
    go_file: Option<PathBuf>,
    /// The `agentCapabilities` object the agent answers `initialize` with.
    agent_capabilities: serde_json::Value,
}

impl ExternalAgentServer for PythonResolver {
    fn get_command(
        &self,
        _extra_args: Vec<String>,
        _extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        let script = FAKE_AGENT
            .replace(
                "PID_FILE",
                &format!("{:?}", self.pid_file.display().to_string()),
            )
            .replace(
                "GO_FILE",
                &match &self.go_file {
                    Some(path) => format!("{:?}", path.display().to_string()),
                    None => "None".to_string(),
                },
            )
            .replace(
                "AGENT_CAPABILITIES",
                &format!("{:?}", self.agent_capabilities.to_string()),
            );
        let path = self.python.clone();
        async move {
            Ok(AgentServerCommand {
                path,
                args: vec!["-c".to_string(), script],
                env: Some(HashMap::new()),
            })
        }
        .boxed()
    }
}

struct SpawningCatalog {
    id: AgentId,
    python: PathBuf,
    pid_file: PathBuf,
    go_file: Option<PathBuf>,
    agent_capabilities: serde_json::Value,
}

impl atlas_agent_manager::AgentCatalog for SpawningCatalog {
    fn external_agents(&self) -> Vec<AgentId> {
        vec![self.id.clone()]
    }

    fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        (id == &self.id).then(|| {
            Arc::new(PythonResolver {
                python: self.python.clone(),
                pid_file: self.pid_file.clone(),
                go_file: self.go_file.clone(),
                agent_capabilities: self.agent_capabilities.clone(),
            }) as Arc<dyn ExternalAgentServer>
        })
    }

    fn default_mode(&self, _id: &AgentId) -> Option<acp::SessionModeId> {
        None
    }

    fn watch_new_version(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }

    fn watch_loading_status(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }

    fn updates(&self) -> watch::Receiver<u64> {
        watch::channel(0).1
    }
}

/// The session requests the agent writing `pid_file` has received, in order:
/// `(method, params)`.
pub fn session_requests(pid_file: &Path) -> Vec<(String, serde_json::Value)> {
    std::fs::read_to_string(requests_file(pid_file))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["params"].clone(),
            )
        })
        .collect()
}

fn requests_file(pid_file: &Path) -> PathBuf {
    PathBuf::from(format!("{}.requests", pid_file.display()))
}

/// Builds a manager whose one installed agent is a real process, and returns
/// the file that process writes its pid into.
pub fn spawning_manager(tag: &str) -> Option<(Arc<AgentManager>, PathBuf)> {
    manager_advertising_capabilities(tag, serde_json::json!({}))
}

/// The same, with an agent that answers `initialize` with the given
/// `agentCapabilities`.
pub fn manager_advertising_capabilities(
    tag: &str,
    agent_capabilities: serde_json::Value,
) -> Option<(Arc<AgentManager>, PathBuf)> {
    spawning_manager_inner(tag, false, agent_capabilities, None)
        .map(|(manager, pid_file, _)| (manager, pid_file))
}

/// The same, with the host handing sessions the MCP servers `session_mcp`
/// offers.
pub fn manager_offering_mcp(
    tag: &str,
    agent_capabilities: serde_json::Value,
    session_mcp: Arc<dyn SessionMcpServers>,
) -> Option<(Arc<AgentManager>, PathBuf)> {
    spawning_manager_inner(tag, false, agent_capabilities, Some(session_mcp))
        .map(|(manager, pid_file, _)| (manager, pid_file))
}

/// The same, with an agent that parks after spawning until the returned
/// `go_file` is created.
pub fn parked_manager(tag: &str) -> Option<(Arc<AgentManager>, PathBuf, PathBuf)> {
    spawning_manager_inner(tag, true, serde_json::json!({}), None)
}

fn spawning_manager_inner(
    tag: &str,
    park: bool,
    agent_capabilities: serde_json::Value,
    session_mcp: Option<Arc<dyn SessionMcpServers>>,
) -> Option<(Arc<AgentManager>, PathBuf, PathBuf)> {
    let python = python()?;
    let pid_file = std::env::temp_dir().join(format!(
        "atlas-agent-manager-{tag}-{}",
        std::process::id()
    ));
    let go_file = std::env::temp_dir().join(format!(
        "atlas-agent-manager-{tag}-go-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&go_file);
    let _ = std::fs::remove_file(requests_file(&pid_file));

    let catalog = Arc::new(SpawningCatalog {
        id: AgentId::new("fake-agent"),
        python,
        pid_file: pid_file.clone(),
        go_file: park.then(|| go_file.clone()),
        agent_capabilities,
    });
    // The native server is never used here; every path goes through the
    // installed agent.
    let native: Arc<dyn atlas_agent_servers::AgentServer> = super::TestServer::new("unused");
    Some((
        AgentManager::new(
            catalog,
            native,
            ConnectOptions {
                session_mcp,
                ..connect_options()
            },
        ),
        pid_file,
        go_file,
    ))
}

pub async fn agent_pid(pid_file: &Path) -> Option<i32> {
    wait_for(|| {
        std::fs::read_to_string(pid_file)
            .ok()
            .and_then(|raw| raw.trim().parse::<i32>().ok())
    })
    .await
}
