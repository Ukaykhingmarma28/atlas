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
//! dynamic `search_memory` tool it replaced had — and they are kept out of the
//! **deferred** surface, which puts them in the model's initial tool list
//! instead of behind a tool search.
//!
//! That second one is the whole of the shared-memory read problem: deferred is
//! the engine's default for MCP tools on any model with a search tool, and a
//! model cannot call a handle it has to go looking for first. Whether it went
//! looking varied run to run, which is why memory was reliably written and
//! only sometimes read. Nothing about the protocol changes — memory is still
//! pulled by the agent, and nothing is added to the user's message (ADR-0010)
//! — only whether the handle is visible.
//!
//! Both of those standings are the host's to grant, and both ride on the
//! sentence above: everything projected here is a server Atlas itself offers.
//! A user-configured HTTP server would inherit them, so that assumption is
//! load-bearing rather than incidental.

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
        // Out of the deferred surface, so these tools are in the model's
        // initial list rather than behind a tool search. See the module doc.
        config.insert(key("omit_tools_from"), json!(["deferred"]));
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

    /// The whole of #286's read half: deferred tools sit behind a tool search,
    /// so the model has to go looking before it can find memory at all.
    #[test]
    fn the_memory_tools_are_kept_out_of_the_deferred_surface() {
        let server = acp::McpServer::Http(acp::McpServerHttp::new(
            "atlas_memory",
            "http://127.0.0.1:9/mcp",
        ));
        let config = thread_config(&[server]).expect("one entry");
        assert_eq!(
            config["mcp_servers.atlas_memory.omit_tools_from"],
            json!(["deferred"]),
        );
    }

    /// The projection is only half the story: these are DOTTED keys, merged
    /// into a TOML tree and then deserialized into the engine's own config.
    /// An unknown or wrongly-shaped key on that path is dropped rather than
    /// refused, so a mistake here would leave the tools deferred with nothing
    /// to show for it. Run the whole path the engine runs, and read the value
    /// off the struct the exposure policy actually consults.
    #[test]
    fn the_dotted_keys_survive_the_merge_into_the_engines_own_config() {
        use codex_protocol::config_types::ToolExposureSurface;

        let projected = thread_config(&[acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_memory", "http://127.0.0.1:9/mcp")
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
        )])
        .expect("one entry");

        // Exactly what `ConfigManager::load_with_overrides` does with them.
        let overrides: Vec<(String, toml::Value)> = projected
            .into_iter()
            .map(|(key, value)| (key, codex_utils_json_to_toml::json_to_toml(value)))
            .collect();
        let merged = codex_config::build_cli_overrides_layer(&overrides);

        let servers = merged
            .get("mcp_servers")
            .and_then(|v| v.get("atlas_memory"))
            .expect("the dotted keys nest into mcp_servers.atlas_memory");
        let server: codex_config::McpServerConfig =
            servers.clone().try_into().expect("the engine parses it");

        assert_eq!(
            server.omit_tools_from.as_deref(),
            Some(&[ToolExposureSurface::Deferred][..]),
            "the tools must reach the model's initial list, not the deferred surface",
        );
    }

    #[test]
    fn no_servers_is_no_override() {
        assert_eq!(thread_config(&[]), None);
    }
}
