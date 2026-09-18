//! A manager whose one installed agent is a real child process: a small
//! python script answering `initialize` and `session/new`, the same fixture
//! shape `atlas-agent-servers/tests/connect.rs` uses. Shared by the test
//! binaries that need the spawn-and-handshake path rather than a fake
//! connection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::AgentId;
use atlas_agent_manager::AgentManager;
use atlas_agent_servers::{AgentServerCommand, ExternalAgentServer};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::watch;

use super::{connect_options, wait_for};

/// Answers `initialize` and `session/new`, then sits there. Writes its pid
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
    elif method == "session/new":
        result = {"sessionId": "session-1"}
    else:
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
"#;

fn python() -> Option<&'static str> {
    [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ]
    .into_iter()
    .find(|path| Path::new(path).exists())
}

/// Resolves the fake agent's command, the way the real store resolves an
/// installed agent's.
struct PythonResolver {
    python: &'static str,
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
        let path = PathBuf::from(self.python);
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
    python: &'static str,
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
                python: self.python,
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
    spawning_manager_inner(tag, false, agent_capabilities)
        .map(|(manager, pid_file, _)| (manager, pid_file))
}

/// The same, with an agent that parks after spawning until the returned
/// `go_file` is created.
pub fn parked_manager(tag: &str) -> Option<(Arc<AgentManager>, PathBuf, PathBuf)> {
    spawning_manager_inner(tag, true, serde_json::json!({}))
}

fn spawning_manager_inner(
    tag: &str,
    park: bool,
    agent_capabilities: serde_json::Value,
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
        AgentManager::new(catalog, native, connect_options()),
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
