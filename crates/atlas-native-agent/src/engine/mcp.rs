//! MCP servers the host hands a native session, as engine configuration.
//!
//! ACP agents receive MCP servers on the session request; the engine reads
//! them from its configuration (`mcp_servers.<name>`). A thread's
//! `thread/start` and `thread/resume` carry per-thread config overrides in the
//! same dotted spelling as the connection's own, so each thread gets its own
//! entry — and with it its own bearer token, which a connection-wide override
//! could not carry.
//!
//! Only HTTP servers are projected: the engine speaks StreamableHttp natively,
//! and the host offers nothing else today. The memory tool server is the host's
//! own, so its tools run without an approval prompt — the same standing the
//! dynamic `search_memory` tool it replaced had.

use std::collections::HashMap;

use agent_client_protocol::schema::v1 as acp;
use serde_json::{json, Value as JsonValue};

/// The per-thread config overrides for `servers`; `None` when there are none.
pub fn thread_config(servers: &[acp::McpServer]) -> Option<HashMap<String, JsonValue>> {
    let mut config = HashMap::new();
    for server in servers {
        let acp::McpServer::Http(http) = server else {
            continue;
        };
        let key = |field: &str| format!("mcp_servers.{}.{field}", http.name);
        config.insert(key("url"), json!(http.url));
        if !http.headers.is_empty() {
            let headers: serde_json::Map<String, JsonValue> = http
                .headers
                .iter()
                .map(|h| (h.name.clone(), JsonValue::String(h.value.clone())))
                .collect();
            config.insert(key("http_headers"), JsonValue::Object(headers));
        }
        config.insert(key("default_tools_approval_mode"), json!("approve"));
    }
    (!config.is_empty()).then_some(config)
}

/// The names the engine will report `servers` under: the HTTP ones
/// `thread_config` projects, and no others.
pub fn server_names(servers: &[acp::McpServer]) -> Vec<String> {
    servers
        .iter()
        .filter_map(|server| match server {
            acp::McpServer::Http(http) => Some(http.name.clone()),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_http_server_becomes_a_streamable_http_entry_with_its_headers() {
        let server = acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_memory", "http://127.0.0.1:9/mcp")
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
        );
        let config = thread_config(&[server]).expect("one entry");
        assert_eq!(config["mcp_servers.atlas_memory.url"], json!("http://127.0.0.1:9/mcp"));
        assert_eq!(
            config["mcp_servers.atlas_memory.http_headers"],
            json!({ "Authorization": "Bearer t" }),
        );
        assert_eq!(config["mcp_servers.atlas_memory.default_tools_approval_mode"], json!("approve"));
    }

    #[test]
    fn no_servers_is_no_override() {
        assert_eq!(thread_config(&[]), None);
    }
}
