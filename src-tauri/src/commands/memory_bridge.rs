//! `atlas mcp-bridge <url>`: a stdio MCP server that forwards every message
//! to Atlas's own loopback tool server (ADR-0019), for agents that can only
//! launch stdio MCP servers. The session token arrives in `ATLAS_MCP_TOKEN`,
//! never on the command line.
//!
//! One JSON-RPC message per input line is POSTed to the server; every
//! message in the answer (a JSON body, or each SSE `data:` line) is written
//! back as one line. The MCP session id the server hands out on `initialize`
//! rides every later request.

use anyhow::{bail, Result};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Forward `input` to the server at `url` until `input` ends.
pub async fn bridge(
    url: &str,
    token: &str,
    input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        bail!("the bridge only forwards to Atlas's loopback server");
    }
    let client = reqwest::Client::new();
    let mut session: Option<String> = None;
    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let mut req = client
            .post(url)
            .bearer_auth(token)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(line.clone());
        if let Some(id) = &session {
            req = req.header("Mcp-Session-Id", id);
        }
        let resp = req.send().await?;
        if let Some(id) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            session = Some(id.to_string());
        }
        let status = resp.status();
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("text/event-stream"));
        let body = resp.text().await?;
        if !status.is_success() {
            bail!("the memory server answered {status}: {}", body.trim());
        }
        for message in messages(&body, is_sse) {
            output.write_all(message.as_bytes()).await?;
            output.write_all(b"\n").await?;
        }
        output.flush().await?;
    }
    Ok(())
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
    use super::*;

    #[test]
    fn an_answer_is_its_sse_data_lines_or_its_body() {
        let sse = "id: 0\ndata:\n\nevent: message\ndata: {\"id\":1}\n\n";
        assert_eq!(messages(sse, true), ["{\"id\":1}"]);
        assert_eq!(messages(" {\"id\":2} ", false), ["{\"id\":2}"]);
        assert!(messages("", false).is_empty());
    }

    #[tokio::test]
    async fn the_bridge_refuses_anything_but_loopback() {
        let out = Vec::new();
        let err = bridge(
            "https://example.com/mcp",
            "t",
            tokio::io::BufReader::new(&b""[..]),
            out,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("loopback"));
    }
}
