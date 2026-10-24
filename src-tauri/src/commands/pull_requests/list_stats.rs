//! The list's line counts: each pull request's additions and deletions with
//! the changed files behind them, read for the rows on screen in one aliased
//! request per batch, so the list can split a change into code, tests, mocks
//! and generated files on hover without a request per row.

use serde::Serialize;
use serde_json::Value;

use super::{open, pull_number, PrError};

/// Aliased pull requests in one request. Each carries up to a hundred file
/// nodes, so this stays well under GraphQL's node limit.
const STATS_PER_REQUEST: usize = 25;
/// The most numbers one call reads: a screen of rows, with room.
const STATS_MAX_NUMBERS: usize = 100;
/// Files read per pull request; past it the split is reported truncated.
const FILES_PER_PULL: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileStat {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListStat {
    pub number: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<PrFileStat>,
    /// More files changed than were read: the split would be partial.
    pub files_truncated: bool,
}

fn stats_query(numbers: &[u64]) -> String {
    let fields: String = numbers
        .iter()
        .enumerate()
        .map(|(ix, number)| {
            format!(
                "    p{ix}: pullRequest(number: {number}) {{\n      number\n      additions\n      deletions\n      files(first: {FILES_PER_PULL}) {{\n        pageInfo {{ hasNextPage }}\n        nodes {{ path additions deletions }}\n      }}\n    }}\n"
            )
        })
        .collect();
    format!(
        "query PullRequestListStats($owner: String!, $name: String!) {{\n  repository(owner: $owner, name: $name) {{\n{fields}  }}\n}}"
    )
}

fn count(node: &Value, key: &str) -> u64 {
    node.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// The answered pull requests, in the order asked; a `null` alias (a number
/// the repository does not have) is left out.
fn parse_stats(data: &Value, asked: usize) -> Vec<PrListStat> {
    let Some(repository) = data.get("repository") else {
        return Vec::new();
    };
    (0..asked)
        .filter_map(|ix| repository.get(format!("p{ix}")))
        .filter(|node| !node.is_null())
        .filter_map(|node| {
            let number = node.get("number").and_then(Value::as_u64)?;
            let files = node.get("files");
            let files_truncated = files
                .and_then(|f| f.get("pageInfo"))
                .and_then(|p| p.get("hasNextPage"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let files = files
                .and_then(|f| f.get("nodes"))
                .and_then(Value::as_array)
                .map(|nodes| {
                    nodes
                        .iter()
                        .filter_map(|file| {
                            Some(PrFileStat {
                                path: file.get("path").and_then(Value::as_str)?.to_string(),
                                additions: count(file, "additions"),
                                deletions: count(file, "deletions"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(PrListStat {
                number,
                additions: count(node, "additions"),
                deletions: count(node, "deletions"),
                files,
                files_truncated,
            })
        })
        .collect()
}

/// Line counts and changed files for the given pull requests, as many as the
/// repository has; a number it does not have is left out of the answer.
#[tauri::command]
pub async fn pr_list_stats(path: String, numbers: Vec<u64>) -> Result<Vec<PrListStat>, PrError> {
    let mut wanted: Vec<u64> = Vec::with_capacity(numbers.len().min(STATS_MAX_NUMBERS));
    for number in numbers {
        let number = pull_number(number)?;
        if !wanted.contains(&number) {
            wanted.push(number);
        }
        if wanted.len() == STATS_MAX_NUMBERS {
            break;
        }
    }
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let github = open(&path).await?;
    let mut out = Vec::with_capacity(wanted.len());
    for chunk in wanted.chunks(STATS_PER_REQUEST) {
        match github.read_aliased(&stats_query(chunk)).await {
            Ok(data) => out.extend(parse_stats(&data, chunk.len())),
            // Every number in the batch was gone: nothing to count.
            Err(PrError::NotFound) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_query_aliases_each_number_once() {
        let query = stats_query(&[12, 7]);
        assert!(query.contains("p0: pullRequest(number: 12)"));
        assert!(query.contains("p1: pullRequest(number: 7)"));
        assert!(query.contains("files(first: 100)"));
        assert!(query.contains("$owner: String!, $name: String!"));
    }

    #[test]
    fn answers_are_read_in_order_and_missing_numbers_left_out() {
        let data = json!({
            "repository": {
                "p0": {
                    "number": 12,
                    "additions": 30,
                    "deletions": 4,
                    "files": {
                        "pageInfo": { "hasNextPage": true },
                        "nodes": [
                            { "path": "src/a.ts", "additions": 20, "deletions": 4 },
                            { "path": "src/a.test.ts", "additions": 10, "deletions": 0 },
                            { "additions": 1 }
                        ]
                    }
                },
                "p1": null
            }
        });
        let stats = parse_stats(&data, 2);
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].number, 12);
        assert_eq!((stats[0].additions, stats[0].deletions), (30, 4));
        assert!(stats[0].files_truncated);
        assert_eq!(stats[0].files.len(), 2);
        assert_eq!(stats[0].files[1].path, "src/a.test.ts");
        assert!(parse_stats(&json!({}), 1).is_empty());
    }
}
