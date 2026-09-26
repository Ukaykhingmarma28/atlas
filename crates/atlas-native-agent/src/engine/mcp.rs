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
//! and the host offers nothing else today. Atlas's tool servers — memory
//! (ADR-0010), UI (ADR-0012) and organisation (ADR-0014) — are the host's
//! own, so their tools run
//! without an approval prompt — the same standing the
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
//!
//! # Outward actions ask first (ADR-0014)
//!
//! One exception to "no approval prompt": a tool that reaches another person
//! in the user's name — a reply on a comment thread, a message — is projected
//! with a per-tool `prompt` over its server's `approve` ([`ASK_FIRST`]). The
//! engine then stops before the call and asks, and the native seam puts that
//! ask on the approval card with the recipient and the full body
//! (`engine::tool_approvals`). Everything else on the server keeps running
//! unasked. A later outward tool is one more line in the table.

use std::collections::HashMap;

use agent_client_protocol::schema::v1 as acp;
use serde_json::{json, Value as JsonValue};

/// The tools that ask before they run, as `(server, tool)`: the outward
/// actions of the servers Atlas offers (ADR-0014). Each is projected as
/// `mcp_servers.<server>.tools.<tool>.approval_mode = "prompt"`, over the
/// server's `approve`.
pub const ASK_FIRST: &[(&str, &str)] = &[("atlas_org", "org_comment_reply")];

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
        for (_, tool) in ASK_FIRST.iter().filter(|(server, _)| *server == http.name) {
            config.insert(key(&format!("tools.{tool}.approval_mode")), json!("prompt"));
        }
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
        use atlas_engine_protocol::config_types::ToolExposureSurface;

        let projected = thread_config(&[acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_memory", "http://127.0.0.1:9/mcp")
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
        )])
        .expect("one entry");

        // Exactly what `ConfigManager::load_with_overrides` does with them.
        let overrides: Vec<(String, toml::Value)> = projected
            .into_iter()
            .map(|(key, value)| (key, atlas_engine_utils_json_to_toml::json_to_toml(value)))
            .collect();
        let merged = atlas_engine_config::build_cli_overrides_layer(&overrides);

        let servers = merged
            .get("mcp_servers")
            .and_then(|v| v.get("atlas_memory"))
            .expect("the dotted keys nest into mcp_servers.atlas_memory");
        let server: atlas_engine_config::McpServerConfig =
            servers.clone().try_into().expect("the engine parses it");

        assert_eq!(
            server.omit_tools_from.as_deref(),
            Some(&[ToolExposureSurface::Deferred][..]),
            "the tools must reach the model's initial list, not the deferred surface",
        );
    }

    /// ADR-0012: the UI tool server rides beside memory, and gets the same two
    /// standings — no approval prompt, in the initial tool list.
    #[test]
    fn two_atlas_servers_become_two_entries_each_approved_and_non_deferred() {
        let servers = ["atlas_memory", "atlas_ui"].map(|name| {
            acp::McpServer::Http(
                acp::McpServerHttp::new(name, format!("http://127.0.0.1:9/{name}"))
                    .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
            )
        });
        let config = thread_config(&servers).expect("two entries");
        for name in ["atlas_memory", "atlas_ui"] {
            assert_eq!(config[&format!("mcp_servers.{name}.default_tools_approval_mode")], json!("approve"));
            assert_eq!(config[&format!("mcp_servers.{name}.omit_tools_from")], json!(["deferred"]));
        }
        assert_eq!(server_names(&servers), ["atlas_memory", "atlas_ui"]);
    }

    /// ADR-0014: the organisation tool server is the third entry, on the same
    /// token, with the same standings. Its outward actions will ask through
    /// per-tool overrides; the server itself stays approved.
    #[test]
    fn three_atlas_servers_become_three_entries_each_approved_and_non_deferred() {
        let names = ["atlas_memory", "atlas_ui", "atlas_org"];
        let servers = names.map(|name| {
            acp::McpServer::Http(
                acp::McpServerHttp::new(name, format!("http://127.0.0.1:9/{name}"))
                    .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
            )
        });
        let config = thread_config(&servers).expect("three entries");
        for name in names {
            assert_eq!(config[&format!("mcp_servers.{name}.url")], json!(format!("http://127.0.0.1:9/{name}")));
            assert_eq!(config[&format!("mcp_servers.{name}.http_headers")], json!({ "Authorization": "Bearer t" }));
            assert_eq!(config[&format!("mcp_servers.{name}.default_tools_approval_mode")], json!("approve"));
            assert_eq!(config[&format!("mcp_servers.{name}.omit_tools_from")], json!(["deferred"]));
        }
        assert_eq!(server_names(&servers), names);
    }

    /// ADR-0014: reading comments and resolving one are not outward actions
    /// — a resolve reaches no one, shows on the Timeline, is undone by the
    /// same call and is audited — so neither may ask. Run the whole merge the
    /// engine runs and read each tool's standing off the engine's own config:
    /// the server stays `approve`, and neither tool has a per-tool `prompt`.
    #[test]
    fn the_comment_tools_stay_auto_approved_in_the_projection() {
        use atlas_engine_config::AppToolApproval;

        let projected = thread_config(&[acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_org", "http://127.0.0.1:9/org")
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
        )])
        .expect("one entry");
        let overrides: Vec<(String, toml::Value)> = projected
            .into_iter()
            .map(|(key, value)| (key, atlas_engine_utils_json_to_toml::json_to_toml(value)))
            .collect();
        let merged = atlas_engine_config::build_cli_overrides_layer(&overrides);
        let server: atlas_engine_config::McpServerConfig = merged
            .get("mcp_servers")
            .and_then(|v| v.get("atlas_org"))
            .expect("mcp_servers.atlas_org")
            .clone()
            .try_into()
            .expect("the engine parses it");

        assert_eq!(server.default_tools_approval_mode, Some(AppToolApproval::Approve));
        for tool in ["org_comments", "org_comment_resolve"] {
            let standing = server.tools.get(tool).and_then(|t| t.approval_mode);
            assert_ne!(standing, Some(AppToolApproval::Prompt), "{tool} must not ask");
            assert_eq!(
                standing.or(server.default_tools_approval_mode),
                Some(AppToolApproval::Approve),
                "{tool} runs on the server's approve",
            );
        }
    }

    /// ADR-0014: an outward action asks first. Run the whole merge the engine
    /// runs and read the standing off the engine's own config: the server is
    /// still `approve`, and `org_comment_reply` alone is `prompt` over it.
    #[test]
    fn a_reply_on_a_comment_thread_asks_first_and_the_server_stays_approved() {
        use atlas_engine_config::AppToolApproval;

        let projected = thread_config(&[acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_org", "http://127.0.0.1:9/org")
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer t")]),
        )])
        .expect("one entry");
        assert_eq!(
            projected["mcp_servers.atlas_org.tools.org_comment_reply.approval_mode"],
            json!("prompt"),
        );
        let overrides: Vec<(String, toml::Value)> = projected
            .into_iter()
            .map(|(key, value)| (key, atlas_engine_utils_json_to_toml::json_to_toml(value)))
            .collect();
        let merged = atlas_engine_config::build_cli_overrides_layer(&overrides);
        let server: atlas_engine_config::McpServerConfig = merged
            .get("mcp_servers")
            .and_then(|v| v.get("atlas_org"))
            .expect("mcp_servers.atlas_org")
            .clone()
            .try_into()
            .expect("the engine parses it");

        assert_eq!(server.default_tools_approval_mode, Some(AppToolApproval::Approve));
        assert_eq!(
            server.tools.get("org_comment_reply").and_then(|t| t.approval_mode),
            Some(AppToolApproval::Prompt),
            "the reply asks before anything leaves the device",
        );
        assert_eq!(server.tools.len(), 1, "nothing else on the server asks");
    }

    /// The per-tool prompts are the organisation server's; memory and UI
    /// carry none, and keep running unasked.
    #[test]
    fn only_the_organisation_servers_outward_tools_ask() {
        let servers = ["atlas_memory", "atlas_ui", "atlas_org"].map(|name| {
            acp::McpServer::Http(acp::McpServerHttp::new(name, format!("http://127.0.0.1:9/{name}")))
        });
        let config = thread_config(&servers).expect("three entries");
        let prompted: Vec<&String> = config.keys().filter(|k| k.contains(".tools.")).collect();
        assert_eq!(prompted, ["mcp_servers.atlas_org.tools.org_comment_reply.approval_mode"]);
    }

    #[test]
    fn no_servers_is_no_override() {
        assert_eq!(thread_config(&[]), None);
    }
}
