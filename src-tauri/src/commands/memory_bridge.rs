//! `atlas mcp-bridge <url>`: a stdio MCP server that forwards every message
//! to Atlas's own loopback tool server (ADR-0019), for agents that can only
//! launch stdio MCP servers. The session token arrives in `ATLAS_MCP_TOKEN`,
//! never on the command line.
//!
//! One JSON-RPC message per input line is POSTed to the server; every
//! message in the answer (a JSON body, or each SSE `data:` line) is written
//! back as one line, whatever the HTTP status. The MCP session id the server
//! hands out on `initialize` rides every later request, with the protocol
//! version that `initialize` negotiated. When the server has dropped the
//! session, the client's own handshake is replayed to open a new one.

use anyhow::{bail, Result};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Forward `input` to the server at `url` until `input` ends.
pub async fn bridge(
    url: &str,
    token: &str,
    input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    let server = Server {
        url: loopback_url(url)?,
        // Loopback only, so never through a proxy from the agent's
        // environment: it could not reach this machine's loopback, and the
        // token would land in its logs.
        client: reqwest::Client::builder().no_proxy().build()?,
        token,
    };
    let mut session: Option<String> = None;
    let mut protocol: Option<String> = None;
    // The client's handshake, kept to open a new session with.
    let mut initialize: Option<String> = None;
    let mut initialized: Option<String> = None;
    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(&line).unwrap_or_default();
        let method = message.get("method").and_then(Value::as_str);
        match method {
            Some("initialize") => initialize = Some(line.clone()),
            Some("notifications/initialized") => initialized = Some(line.clone()),
            _ => {}
        }
        // `initialize` carries its version in the body, and a header that
        // disagreed with it would be refused.
        let is_init = method == Some("initialize");
        let mut answer = server
            .post(
                &line,
                session.as_deref(),
                protocol.as_deref().filter(|_| !is_init),
            )
            .await?;
        if answer.status == reqwest::StatusCode::NOT_FOUND
            && session.is_some()
            && !answer.is_jsonrpc()
        {
            // The server no longer knows the session (it idled out, or the
            // app restarted the server): open a new one with the client's
            // handshake, dropping its answers, and retry this line once.
            if let Some(init) = &initialize {
                let opened = server.post(init, None, None).await?;
                protocol = opened.protocol_version().or(protocol);
                session = opened.session;
                if let Some(note) = &initialized {
                    server
                        .post(note, session.as_deref(), protocol.as_deref())
                        .await?;
                }
                answer = server
                    .post(
                        &line,
                        session.as_deref(),
                        protocol.as_deref().filter(|_| !is_init),
                    )
                    .await?;
            }
        }
        if let Some(id) = answer.session.take() {
            session = Some(id);
        }
        if is_init {
            protocol = answer.protocol_version().or(protocol);
        }
        // A JSON-RPC error is the client's to read, whatever the status;
        // only an answer that is not JSON-RPC at all ends the bridge.
        if !answer.status.is_success() && !answer.is_jsonrpc() {
            bail!(
                "the memory server answered {}: {}",
                answer.status,
                answer.body.trim()
            );
        }
        for message in &answer.messages {
            output.write_all(message.as_bytes()).await?;
            output.write_all(b"\n").await?;
        }
        output.flush().await?;
    }
    Ok(())
}

/// `url` parsed, when it names Atlas's loopback server: plain `http` to
/// `localhost` or a loopback address, with no userinfo (which would move the
/// real host past the `@`).
fn loopback_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).ok().filter(|u| {
        let host = u.host_str().unwrap_or_default();
        let loopback = host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        u.scheme() == "http" && loopback && u.username().is_empty() && u.password().is_none()
    });
    match parsed {
        Some(url) => Ok(url),
        None => bail!("the bridge only forwards to Atlas's loopback server"),
    }
}

/// Where the bridge forwards to.
struct Server<'a> {
    url: reqwest::Url,
    client: reqwest::Client,
    token: &'a str,
}

/// One answer from the server.
struct Answer {
    status: reqwest::StatusCode,
    /// The `Mcp-Session-Id` it handed out, if any.
    session: Option<String>,
    body: String,
    messages: Vec<String>,
}

impl Server<'_> {
    /// POST one message, with the session id and protocol version if known.
    async fn post(
        &self,
        line: &str,
        session: Option<&str>,
        protocol: Option<&str>,
    ) -> Result<Answer> {
        let mut req = self
            .client
            .post(self.url.clone())
            .bearer_auth(self.token)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(line.to_owned());
        if let Some(id) = session {
            req = req.header("Mcp-Session-Id", id);
        }
        if let Some(version) = protocol {
            req = req.header("MCP-Protocol-Version", version);
        }
        let resp = req.send().await?;
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let status = resp.status();
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("text/event-stream"));
        let body = resp.text().await?;
        let messages = messages(&body, is_sse);
        Ok(Answer {
            status,
            session,
            body,
            messages,
        })
    }
}

impl Answer {
    /// Whether the answer is one or more JSON-RPC messages.
    fn is_jsonrpc(&self) -> bool {
        !self.messages.is_empty()
            && self
                .messages
                .iter()
                .all(|m| serde_json::from_str::<Value>(m).is_ok_and(|v| v.get("jsonrpc").is_some()))
    }

    /// The protocol version an `initialize` result negotiated.
    fn protocol_version(&self) -> Option<String> {
        self.messages.iter().find_map(|m| {
            serde_json::from_str::<Value>(m)
                .ok()?
                .pointer("/result/protocolVersion")?
                .as_str()
                .map(str::to_owned)
        })
    }
}

/// The JSON-RPC messages in one answer: each SSE `data:` line, or the JSON
/// body. A notification's `202` has none.
fn messages(body: &str, is_sse: bool) -> Vec<String> {
    if is_sse {
        body.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect()
    } else if body.trim().is_empty() {
        Vec::new()
    } else {
        vec![body.trim().to_string()]
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::BufReader;

    use super::*;

    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bridge-test","version":"0"}}}"#;
    const INITIALIZED: &str = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;

    /// A real MCP server on loopback whose sessions end after `keep_alive`
    /// without a request.
    async fn mcp_server(keep_alive: Duration) -> String {
        use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
        use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
        struct Quiet;
        impl rmcp::ServerHandler for Quiet {}
        let mut sessions = LocalSessionManager::default();
        sessions.session_config.keep_alive = Some(keep_alive);
        let service = StreamableHttpService::new(
            || Ok(Quiet),
            Arc::new(sessions),
            StreamableHttpServerConfig::default(),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, axum::Router::new().nest_service("/mcp", service)).await
        });
        format!("http://{addr}/mcp")
    }

    /// A stand-in server: `initialize` answers with a session and a
    /// negotiated version, `fail` with a plain-text 500, anything else with
    /// a JSON-RPC error under HTTP 400. Each answer names the
    /// `MCP-Protocol-Version` the request carried.
    async fn erring_server() -> String {
        use axum::http::{HeaderMap, StatusCode};
        let app = axum::Router::new().route(
            "/mcp",
            axum::routing::post(|headers: HeaderMap, body: String| async move {
                let sent = headers
                    .get("mcp-protocol-version")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("none")
                    .to_owned();
                let json = [
                    ("content-type", "application/json".to_owned()),
                    ("mcp-session-id", "s1".to_owned()),
                ];
                if body.contains(r#""initialize""#) {
                    (
                        StatusCode::OK,
                        json,
                        format!(
                            r#"{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2025-06-18","sent":"{sent}"}}}}"#
                        ),
                    )
                } else if body.contains(r#""fail""#) {
                    (StatusCode::INTERNAL_SERVER_ERROR, json, "broken".to_owned())
                } else {
                    (
                        StatusCode::BAD_REQUEST,
                        json,
                        format!(
                            r#"{{"jsonrpc":"2.0","id":2,"error":{{"code":-32602,"message":"sent {sent}"}}}}"#
                        ),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}/mcp")
    }

    #[test]
    fn an_answer_is_its_sse_data_lines_or_its_body() {
        let sse = "id: 0\ndata:\n\nevent: message\ndata: {\"id\":1}\n\n";
        assert_eq!(messages(sse, true), ["{\"id\":1}"]);
        assert_eq!(messages(" {\"id\":2} ", false), ["{\"id\":2}"]);
        assert!(messages("", false).is_empty());
    }

    #[test]
    fn only_plain_http_to_a_loopback_host_is_forwarded() {
        for ok in [
            "http://127.0.0.1:5/mcp",
            "http://localhost:5/mcp",
            "http://127.0.0.2:5/mcp",
            "http://[::1]:5/mcp",
        ] {
            assert!(loopback_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "https://example.com/mcp",
            "https://127.0.0.1:5/mcp",
            "http://127.0.0.1:1@attacker.example/mcp",
            "http://localhost:80@evil.com/",
            "http://user@127.0.0.1:5/mcp",
            "http://localhost.evil.com:1/",
            "http://10.0.0.1:5/mcp",
            "not a url",
        ] {
            assert!(loopback_url(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn the_bridge_refuses_anything_but_loopback() {
        for url in [
            "https://example.com/mcp",
            "http://127.0.0.1:1@attacker.example/mcp",
            "http://localhost.evil.com:1/",
        ] {
            let err = bridge(url, "t", BufReader::new(&b""[..]), Vec::new())
                .await
                .unwrap_err();
            assert!(err.to_string().contains("loopback"), "{url}: {err}");
        }
    }

    /// A JSON-RPC error comes back to the client as its line whatever the
    /// HTTP status, later requests carry the negotiated protocol version,
    /// and only an answer that is not JSON-RPC ends the bridge.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_json_rpc_error_is_relayed_whatever_the_status() {
        let url = erring_server().await;
        let (mut to_bridge, bridge_in) = tokio::io::duplex(64 * 1024);
        let (bridge_out, from_bridge) = tokio::io::duplex(64 * 1024);
        let run =
            tokio::spawn(
                async move { bridge(&url, "t", BufReader::new(bridge_in), bridge_out).await },
            );
        for line in [
            INITIALIZE,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call"}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"fail"}"#,
        ] {
            to_bridge.write_all(line.as_bytes()).await.unwrap();
            to_bridge.write_all(b"\n").await.unwrap();
        }
        let mut lines = BufReader::new(from_bridge).lines();
        let first = lines.next_line().await.unwrap().unwrap();
        assert!(first.contains(r#""sent":"none""#), "{first}");
        let second = lines.next_line().await.unwrap().unwrap();
        assert!(second.contains(r#""error""#), "{second}");
        assert!(second.contains("sent 2025-06-18"), "{second}");
        let err = run.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("500"), "{err}");
        drop(to_bridge);
    }

    /// A session the server dropped for idling does not end the bridge: the
    /// client's handshake is replayed and the request retried.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_the_server_dropped_is_opened_again() {
        let url = mcp_server(Duration::from_millis(200)).await;
        let (mut to_bridge, bridge_in) = tokio::io::duplex(64 * 1024);
        let (bridge_out, from_bridge) = tokio::io::duplex(64 * 1024);
        let run =
            tokio::spawn(
                async move { bridge(&url, "t", BufReader::new(bridge_in), bridge_out).await },
            );
        for line in [
            INITIALIZE,
            INITIALIZED,
            r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
        ] {
            to_bridge.write_all(line.as_bytes()).await.unwrap();
            to_bridge.write_all(b"\n").await.unwrap();
        }
        let mut lines = BufReader::new(from_bridge).lines();
        let first = lines.next_line().await.unwrap().unwrap();
        assert!(first.contains(r#""id":1"#), "{first}");
        let second = lines.next_line().await.unwrap().unwrap();
        assert!(second.contains(r#""id":2"#), "{second}");
        // Well past the keep-alive: the server has closed the session.
        tokio::time::sleep(Duration::from_secs(1)).await;
        to_bridge
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let third = lines.next_line().await.unwrap().unwrap();
        assert!(
            third.contains(r#""id":3"#) && third.contains(r#""result""#),
            "{third}"
        );
        drop(to_bridge);
        run.await.unwrap().unwrap();
    }
}
