//! The GitHub driver: each pull-request operation as the `gh` requests it
//! takes, read back through [`parse`](super::parse).
//!
//! A driver is opened per call against a checkout ([`GitHub::open`]), which
//! resolves the repository the checkout's remote names and who is signed in.
//! That answer is remembered for ten minutes per checkout, as is each pull
//! request's node id (which never changes), so a burst of writes — ticking
//! files viewed — does not pay a lookup per press.

use std::collections::{HashMap, VecDeque};
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::gh::{now_ms, Gh, DIFF_TIMEOUT, READ_TIMEOUT, WRITE_TIMEOUT};
use super::model::*;
use super::parse::{self, RepoContext};
use super::queries as q;

/// How long a checkout's repository and viewer are trusted. A remote is
/// rarely repointed and `gh auth switch` is rarer still; ten minutes bounds
/// how long either goes unnoticed.
const REPO_CONTEXT_TTL_MS: i64 = 10 * 60_000;
const NODE_ID_CACHE_CAPACITY: usize = 128;
/// Pages walked for review threads, activity remarks and check contexts
/// before the answer is reported truncated.
const MAX_PAGES: usize = 10;
const FILES_VIEWED_MAX_PAGES: usize = 5;
/// GitHub's per-page ceiling for the files API, and the burst size one
/// viewed-files mutation document carries.
const FILES_PAGE_SIZE: usize = 100;
const FILES_VIEWED_PER_REQUEST: usize = 100;
/// A whole-pull-request patch past this is read a page of files at a time.
const DIFF_MAX_BYTES: usize = 8 * 1024 * 1024;
/// A file shown whole in a diff, past which it is refused rather than read.
const FILE_CONTENTS_MAX_BYTES: usize = 1024 * 1024;
const LIST_DEFAULT_ROWS: u32 = 50;
/// Aliased pull requests in one by-number read; GraphQL's node limit is far
/// above it, and a session never links this many.
const ENTRIES_PER_REQUEST: usize = 50;
const EMPTY_OID: &str = "0000000000000000000000000000000000000000";

static REPO_CONTEXTS: LazyLock<Mutex<HashMap<String, (RepoContext, i64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Default)]
struct NodeIds {
    ids: HashMap<String, String>,
    order: VecDeque<String>,
}

static NODE_IDS: LazyLock<Mutex<NodeIds>> = LazyLock::new(|| Mutex::new(NodeIds::default()));

/// Forget what is remembered about a checkout: after a write that could have
/// changed it, or when the user asks again after an error.
pub(crate) fn forget_repo_context(cwd: &str) {
    REPO_CONTEXTS.lock().remove(cwd);
}

/// `encodeURIComponent`, for one segment of a request path.
pub(crate) fn encode_component(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// A repository path, each segment encoded on its own so its slashes stay
/// separators.
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn not_found_or<T>(value: Option<T>) -> Result<T, PrError> {
    value.ok_or(PrError::NotFound)
}

/// GitHub-facing driver for one checkout.
pub(crate) struct GitHub {
    gh: Gh,
    ctx: RepoContext,
}

impl GitHub {
    pub async fn open(cwd: &str) -> Result<Self, PrError> {
        let gh = Gh::new(cwd);
        let now = now_ms();
        let held = REPO_CONTEXTS
            .lock()
            .get(cwd)
            .filter(|(_, at)| now - at < REPO_CONTEXT_TTL_MS)
            .map(|(ctx, _)| ctx.clone());
        let ctx = match held {
            Some(ctx) => ctx,
            None => {
                let data = gh
                    .graphql_with_repo_placeholders(q::REPOSITORY_CONTEXT)
                    .await?;
                let ctx = parse::to_repo_context(&data).ok_or(PrError::Unsupported {
                    message: "This checkout's remote is not a GitHub repository.".into(),
                })?;
                REPO_CONTEXTS
                    .lock()
                    .insert(cwd.to_string(), (ctx.clone(), now));
                ctx
            }
        };
        Ok(Self { gh, ctx })
    }

    pub fn provider(&self) -> PrProvider {
        PrProvider {
            kind: PrProviderKind::Github,
            host: self.ctx.host.clone(),
            repository: self.ctx.repository(),
            viewer: self.ctx.viewer.clone(),
            capabilities: parse::capabilities(),
        }
    }

    /// `isRequired` is asked for on github.com only: an older Enterprise
    /// server may not know it.
    fn asks_required(&self) -> bool {
        self.ctx.host == "github.com"
    }

    fn vars(&self, number: u64, extra: Value) -> Value {
        let mut vars = json!({ "owner": self.ctx.owner, "name": self.ctx.name, "number": number });
        if let (Some(base), Value::Object(extra)) = (vars.as_object_mut(), extra) {
            base.extend(extra);
        }
        vars
    }

    fn repo_path(&self, rest: &str) -> String {
        format!("repos/{}/{}/{rest}", self.ctx.owner, self.ctx.name)
    }

    /// The key a conditional read's cache entry is filed under: the account
    /// it was read as.
    fn scope(&self) -> String {
        format!(
            "{}@{}",
            self.ctx.viewer.as_deref().unwrap_or("-"),
            self.ctx.host
        )
    }

    async fn read(&self, query: &str, vars: Value) -> Result<Value, PrError> {
        self.gh.graphql(query, vars, true, READ_TIMEOUT).await
    }

    async fn write(&self, query: &str, vars: Value) -> Result<Value, PrError> {
        self.gh.graphql(query, vars, true, WRITE_TIMEOUT).await
    }

    // ── reads ────────────────────────────────────────────────────────────

    pub async fn list(&self, query: &PrListQuery) -> Result<PrListResult, PrError> {
        let involvement = query.involvement.unwrap_or(PrInvolvement::All);
        let viewer = self.ctx.viewer.as_deref().unwrap_or_default();
        if viewer.is_empty() && involvement != PrInvolvement::All {
            return Err(PrError::NotAuthenticated);
        }
        let search = parse::search_query(&self.ctx.repository(), viewer, query)
            .ok_or_else(|| PrError::invalid("This repository's name cannot be searched."))?;
        let rows = query
            .limit
            .unwrap_or(LIST_DEFAULT_ROWS)
            .clamp(1, parse::SEARCH_MAX_ROWS);
        let data = self
            .read(
                &q::pull_request_search(),
                json!({ "q": search, "first": rows, "after": query.cursor }),
            )
            .await?;
        let (entries, next_cursor) = parse::to_list_page(&data, self.ctx.viewer.as_deref());
        Ok(PrListResult {
            provider: self.provider(),
            entries,
            next_cursor,
        })
    }

    /// Pull requests by number, as listing rows, in one request per hundred.
    /// A number the repository does not have is left out of the answer
    /// rather than failing it: GitHub fails the whole document for one
    /// missing pull request, so such a batch is read again one by one.
    pub async fn entries(&self, numbers: &[u64]) -> Result<Vec<PrListEntry>, PrError> {
        let mut out = Vec::with_capacity(numbers.len());
        for chunk in numbers.chunks(ENTRIES_PER_REQUEST) {
            match self.entries_chunk(chunk).await {
                Ok(rows) => out.extend(rows),
                Err(PrError::NotFound) if chunk.len() > 1 => {
                    for number in chunk {
                        match self.entries_chunk(std::slice::from_ref(number)).await {
                            Ok(rows) => out.extend(rows),
                            Err(PrError::NotFound) => {}
                            Err(e) => return Err(e),
                        }
                    }
                }
                Err(PrError::NotFound) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    async fn entries_chunk(&self, numbers: &[u64]) -> Result<Vec<PrListEntry>, PrError> {
        let data = self
            .read(
                &q::pull_requests_by_number(numbers),
                json!({ "owner": self.ctx.owner, "name": self.ctx.name }),
            )
            .await?;
        Ok(parse::to_entries_by_alias(
            &data,
            numbers.len(),
            self.ctx.viewer.as_deref(),
        ))
    }

    pub async fn detail(&self, number: u64) -> Result<PrDetail, PrError> {
        let query = q::pull_request_core();
        let read = |requested: u32| {
            self.read(
                &query,
                self.vars(
                    number,
                    json!({
                        "headRef": format!("refs/pull/{number}/head"),
                        "required": self.asks_required(),
                        "requestedReviewers": requested,
                    }),
                ),
            )
        };
        let data = match read(100).await {
            Err(PrError::GraphqlErrors { errors })
                if parse::is_refused_requested_reviewers_only(&errors) =>
            {
                read(0).await?
            }
            other => other?,
        };
        let mut detail = not_found_or(parse::to_detail(&data, &self.ctx.repository()))?;
        // Past a hundred checks the first page would let the rest imply
        // success, so the whole rollup is walked instead.
        if detail.checks_truncated {
            let (head, contexts, truncated) = self.all_check_contexts(number).await?;
            if head.is_some() && head != detail.head_sha {
                return Err(PrError::failed(
                    "The pull request's head changed while its checks were read.",
                ));
            }
            let refs: Vec<&Value> = contexts.iter().collect();
            detail.checks = parse::to_checks(&refs);
            detail.checks_state = parse::rollup_checks_state(&refs);
            detail.checks_truncated = truncated;
        }
        Ok(detail)
    }

    /// Every check context of the head commit. Each page names the head it
    /// read, so a push mid-walk fails rather than mixing two revisions.
    async fn all_check_contexts(
        &self,
        number: u64,
    ) -> Result<(Option<String>, Vec<Value>, bool), PrError> {
        let query = q::pull_request_check_contexts();
        let mut head: Option<String> = None;
        let mut contexts = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let data = self
                .read(
                    &query,
                    self.vars(
                        number,
                        json!({ "required": self.asks_required(), "after": after }),
                    ),
                )
                .await?;
            let (page_head, page, next) = not_found_or(parse::to_check_contexts_page(&data))?;
            if head.get_or_insert_with(|| page_head.clone()) != &page_head {
                return Err(PrError::failed(
                    "The pull request's head changed while its checks were read.",
                ));
            }
            contexts.extend(page);
            if next.is_none() || next == after {
                return Ok((head, contexts, false));
            }
            after = next;
        }
        Ok((head, contexts, true))
    }

    /// The conversation: issue comments and reviews, merged with the review
    /// threads' line comments, read side by side.
    pub async fn activity(&self, number: u64) -> Result<PrActivity, PrError> {
        let (remarks, threads) = tokio::join!(self.remarks(number), self.review_threads(number));
        let (author, commits, remarks) = remarks?;
        let (threads, page, truncated) = threads?;
        Ok(parse::merge_activity(
            author, commits, remarks, threads, page, truncated,
        ))
    }

    /// Both remark lists page on their own; a page asks only for the ones
    /// with more to give.
    async fn remarks(
        &self,
        number: u64,
    ) -> Result<(Option<PrActor>, Vec<PrCommit>, Vec<PrComment>), PrError> {
        let mut author = None;
        let mut commits = Vec::new();
        let mut remarks = Vec::new();
        let (mut comments_after, mut reviews_after): (Option<String>, Option<String>) =
            (None, None);
        let (mut with_comments, mut with_reviews) = (true, true);
        for page in 0..MAX_PAGES {
            if !(with_comments || with_reviews) {
                break;
            }
            let data = self
                .read(
                    q::PULL_REQUEST_ACTIVITY,
                    self.vars(
                        number,
                        json!({
                            "head": page == 0,
                            "withComments": with_comments,
                            "commentsAfter": comments_after,
                            "withReviews": with_reviews,
                            "reviewsAfter": reviews_after,
                        }),
                    ),
                )
                .await?;
            let read = not_found_or(parse::to_activity_page(&data))?;
            if page == 0 {
                author = read.author;
                commits = read.commits;
            }
            remarks.extend(read.remarks);
            with_comments = with_comments && read.next_comments_cursor.is_some();
            with_reviews = with_reviews && read.next_reviews_cursor.is_some();
            comments_after = read.next_comments_cursor;
            reviews_after = read.next_reviews_cursor;
        }
        remarks.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok((author, commits, remarks))
    }

    /// Every review thread, up to ten pages, with the first page's view of
    /// who is on the review and every page's avatars.
    async fn review_threads(
        &self,
        number: u64,
    ) -> Result<(Vec<PrReviewThread>, parse::ThreadPage, bool), PrError> {
        let query = q::review_threads();
        let mut requested_reviewers = 50;
        let mut threads = Vec::new();
        let mut first: Option<parse::ThreadPage> = None;
        let mut after: Option<String> = None;
        let mut pages = 0;
        loop {
            let read = |requested: u32, after: Option<String>| {
                self.read(
                    &query,
                    self.vars(
                        number,
                        json!({ "after": after, "requestedReviewers": requested }),
                    ),
                )
            };
            let data = match read(requested_reviewers, after.clone()).await {
                Err(PrError::GraphqlErrors { errors })
                    if requested_reviewers > 0
                        && parse::is_refused_requested_reviewers_only(&errors) =>
                {
                    requested_reviewers = 0;
                    read(0, after.clone()).await?
                }
                other => other?,
            };
            let mut page = not_found_or(parse::to_review_thread_page(&data))?;
            threads.append(&mut page.threads);
            let next = page.next_cursor.take();
            match first.as_mut() {
                None => first = Some(page),
                Some(held) => {
                    held.avatars_by_login.extend(page.avatars_by_login);
                    held.bot_logins.extend(page.bot_logins);
                }
            }
            pages += 1;
            if next.is_none() || next == after || pages >= MAX_PAGES {
                after = next.filter(|n| Some(n) != after.as_ref());
                break;
            }
            after = next;
        }
        let mut first = first.unwrap_or_default();
        // Dismissal messages past the thread read's own page.
        let mut dismissal_after = first.next_dismissal_cursor.take();
        let mut seen = std::collections::HashSet::new();
        let mut dismissal_pages = 0;
        while let Some(cursor) = dismissal_after.clone() {
            if dismissal_pages >= MAX_PAGES || !seen.insert(cursor.clone()) {
                break;
            }
            let data = self
                .read(
                    q::REVIEW_DISMISSALS,
                    self.vars(number, json!({ "after": cursor })),
                )
                .await?;
            let (more, next) = not_found_or(parse::to_review_dismissals_page(&data))?;
            first.dismissals_by_review_id.extend(more);
            dismissal_after = next;
            dismissal_pages += 1;
        }
        Ok((threads, first, after.is_some()))
    }

    pub async fn thread_comments(
        &self,
        number: u64,
        thread_id: &str,
        cursor: Option<String>,
    ) -> Result<PrThreadCommentsPage, PrError> {
        if !parse::is_node_id(thread_id) {
            return Err(PrError::invalid("That is not a review thread id."));
        }
        let data = self
            .read(
                &q::review_thread_comments(),
                self.vars(number, json!({ "threadId": thread_id, "after": cursor })),
            )
            .await?;
        let (belongs, page) = parse::to_thread_comments_page(&data);
        if !belongs {
            return Err(PrError::invalid(
                "That review thread belongs to another pull request.",
            ));
        }
        Ok(page)
    }

    pub async fn timeline(
        &self,
        number: u64,
        cursor: Option<String>,
    ) -> Result<PrTimelinePage, PrError> {
        let first_page = cursor.is_none();
        let data = self
            .read(
                q::PULL_REQUEST_TIMELINE,
                self.vars(number, json!({ "after": cursor })),
            )
            .await?;
        not_found_or(parse::to_timeline_page(&data, first_page))
    }

    pub async fn commits(
        &self,
        number: u64,
        cursor: Option<String>,
    ) -> Result<PrCommitsPage, PrError> {
        let data = self
            .read(
                q::PULL_REQUEST_COMMITS,
                self.vars(number, json!({ "after": cursor })),
            )
            .await?;
        not_found_or(parse::to_commits_page(&data))
    }

    /// The patch. The first read asks for the whole pull request as one
    /// diff; GitHub refuses that past 300 files (a 406) and it can run past
    /// [`DIFF_MAX_BYTES`], and either way the files API takes over, a page
    /// per call. A commit is always read through the files API.
    pub async fn diff(
        &self,
        number: u64,
        cursor: Option<String>,
        commit: Option<String>,
    ) -> Result<PrDiffResult, PrError> {
        if let Some(commit) = &commit {
            if !parse::is_commit_sha(commit) {
                return Err(PrError::invalid("That is not a commit SHA."));
            }
        }
        if let Some(cursor) = &cursor {
            let page = parse::diff_cursor_page(cursor)
                .ok_or_else(|| PrError::invalid("That is not a page of this diff."))?;
            return self.files_page(number, page, commit.as_deref()).await;
        }
        if commit.is_some() {
            return self.files_page(number, 1, commit.as_deref()).await;
        }
        let whole = self
            .gh
            .rest_get(
                &self.repo_path(&format!("pulls/{number}")),
                Some("application/vnd.github.diff"),
                Some(&self.scope()),
                true,
                DIFF_TIMEOUT,
            )
            .await;
        match whole {
            Ok(body) if body.len() <= DIFF_MAX_BYTES => match String::from_utf8(body) {
                Ok(patch) => Ok(PrDiffResult {
                    patch,
                    files: Vec::new(),
                    truncated: false,
                    next_cursor: None,
                    omitted_file_stats: Vec::new(),
                }),
                Err(_) => self.files_page(number, 1, None).await,
            },
            Ok(_) => self.files_page(number, 1, None).await,
            Err(error @ PrError::Failed { .. }) => {
                self.files_page(number, 1, None).await.map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }

    async fn files_page(
        &self,
        number: u64,
        page: u32,
        commit: Option<&str>,
    ) -> Result<PrDiffResult, PrError> {
        let paging = format!("per_page={FILES_PAGE_SIZE}&page={page}");
        let path = match commit {
            None => self.repo_path(&format!("pulls/{number}/files?{paging}")),
            Some(sha) => self.repo_path(&format!("commits/{sha}?{paging}")),
        };
        let body = self
            .gh
            .rest_get(&path, None, Some(&self.scope()), true, DIFF_TIMEOUT)
            .await?;
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| PrError::failed("GitHub's list of changed files could not be read."))?;
        let entries = match commit {
            None => value.as_array().cloned(),
            Some(_) => value.get("files").and_then(Value::as_array).cloned(),
        }
        .unwrap_or_default();
        let files = parse::to_files_patch(&entries);
        Ok(PrDiffResult {
            patch: files.patch,
            files: files.files,
            truncated: files.truncated,
            // Counted before any entry was skipped, so a page whose entries
            // all failed still moves on.
            next_cursor: (files.raw_count >= FILES_PAGE_SIZE).then(|| (page + 1).to_string()),
            omitted_file_stats: files.omitted,
        })
    }

    /// Both sides of one file, for a diff shown in full. The sides are the
    /// pull request's base and head commits (or a commit and its first
    /// parent); GitHub has no merge-base read, so a base that moved on shows
    /// its newer contents.
    pub async fn diff_file_contents(
        &self,
        number: u64,
        commit: Option<String>,
        change_type: PrFileChangeType,
        old_path: &str,
        new_path: &str,
    ) -> Result<PrDiffFileContents, PrError> {
        if let Some(commit) = &commit {
            if !parse::is_commit_sha(commit) {
                return Err(PrError::invalid("That is not a commit SHA."));
            }
        }
        let refs_path = match &commit {
            None => self.repo_path(&format!("pulls/{number}")),
            Some(sha) => self.repo_path(&format!("commits/{sha}")),
        };
        let body = self
            .gh
            .rest_get(&refs_path, None, Some(&self.scope()), true, DIFF_TIMEOUT)
            .await?;
        let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let (base, head) = parse::to_revisions(&value, commit.is_some());
        let root_commit_new_file =
            commit.is_some() && change_type == PrFileChangeType::New && base.is_none();
        let head = head.filter(|h| parse::is_commit_sha(h));
        let base = base.filter(|b| parse::is_commit_sha(b));
        let (Some(head), true) = (head, root_commit_new_file || base.is_some()) else {
            return Err(PrError::Unsupported {
                message: "The revisions on either side of this diff are unavailable.".into(),
            });
        };
        let old = async {
            match (change_type, &base) {
                (PrFileChangeType::New, _) | (_, None) => Ok(String::new()),
                (_, Some(base)) => self.file_at(base, old_path).await,
            }
        };
        let new = async {
            match change_type {
                PrFileChangeType::Deleted => Ok(String::new()),
                _ => self.file_at(&head, new_path).await,
            }
        };
        let (old_contents, new_contents) = tokio::join!(old, new);
        Ok(PrDiffFileContents {
            old_contents: old_contents?,
            new_contents: new_contents?,
        })
    }

    async fn file_at(&self, revision: &str, path: &str) -> Result<String, PrError> {
        let body = self
            .gh
            .rest_get(
                &self.repo_path(&format!(
                    "contents/{}?ref={}",
                    encode_path(path),
                    encode_component(revision)
                )),
                Some("application/vnd.github.raw+json"),
                None,
                true,
                DIFF_TIMEOUT,
            )
            .await?;
        if body.len() > FILE_CONTENTS_MAX_BYTES {
            return Err(PrError::Unsupported {
                message: "This file is too large to show in full.".into(),
            });
        }
        if body.contains(&0) {
            return Err(PrError::Unsupported {
                message: "This file is binary.".into(),
            });
        }
        String::from_utf8(body).map_err(|_| PrError::Unsupported {
            message: "This file is binary.".into(),
        })
    }

    pub async fn files_viewed(&self, number: u64) -> Result<PrFilesViewed, PrError> {
        let mut files = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..FILES_VIEWED_MAX_PAGES {
            let data = self
                .read(
                    q::PULL_REQUEST_FILES_VIEWED,
                    self.vars(number, json!({ "after": after })),
                )
                .await?;
            let (page, next) = parse::to_files_viewed_page(&data);
            files.extend(page);
            if next.is_none() || next == after {
                return Ok(PrFilesViewed {
                    files,
                    truncated: false,
                });
            }
            after = next;
        }
        Ok(PrFilesViewed {
            files,
            truncated: true,
        })
    }

    /// Who the reviewer picker offers. Read when the picker opens, never
    /// with the detail: most readers never open it.
    pub async fn reviewer_candidates(&self, number: u64) -> Result<PrReviewerCandidates, PrError> {
        let data = self
            .read(
                q::PULL_REQUEST_REVIEWER_CANDIDATES,
                self.vars(number, json!({})),
            )
            .await?;
        not_found_or(parse::to_reviewer_candidates(&data))
    }

    /// What the label picker offers.
    pub async fn label_candidates(&self, number: u64) -> Result<PrLabelCandidates, PrError> {
        let data = self
            .read(
                q::PULL_REQUEST_LABEL_CANDIDATES,
                self.vars(number, json!({})),
            )
            .await?;
        not_found_or(parse::to_label_candidates(&data))
    }

    // ── writes ───────────────────────────────────────────────────────────

    /// The pull request's own node id, which mutations on it are addressed
    /// by. Remembered for life.
    async fn node_id(&self, number: u64) -> Result<String, PrError> {
        let key = format!("{} {} {number}", self.ctx.host, self.ctx.repository());
        {
            let mut cache = NODE_IDS.lock();
            if let Some(id) = cache.ids.get(&key).cloned() {
                cache.order.retain(|k| k != &key);
                cache.order.push_back(key);
                return Ok(id);
            }
        }
        let data = self
            .read(q::PULL_REQUEST_NODE_ID, self.vars(number, json!({})))
            .await?;
        let id = not_found_or(parse::trimmed(
            data.get("repository")
                .and_then(|r| r.get("pullRequest"))
                .and_then(|p| p.get("id")),
        ))?;
        let mut cache = NODE_IDS.lock();
        if cache.ids.len() >= NODE_ID_CACHE_CAPACITY {
            if let Some(oldest) = cache.order.pop_front() {
                cache.ids.remove(&oldest);
            }
        }
        cache.ids.insert(key.clone(), id.clone());
        cache.order.push_back(key);
        Ok(id)
    }

    /// Confirms a client-given subject hangs off this pull request, so the
    /// mutation cannot write wherever the id actually belongs.
    async fn check_subject(&self, number: u64, subject_id: &str) -> Result<(), PrError> {
        if !parse::is_node_id(subject_id) {
            return Err(PrError::invalid("That is not a comment or review id."));
        }
        let data = self
            .read(
                q::PULL_REQUEST_SUBJECT,
                self.vars(number, json!({ "subjectId": subject_id })),
            )
            .await?;
        if parse::is_subject_of_pull_request(&data) {
            Ok(())
        } else {
            Err(PrError::invalid("That belongs to another pull request."))
        }
    }

    pub async fn set_files_viewed(
        &self,
        number: u64,
        files: &[PrFileViewedChange],
    ) -> Result<(), PrError> {
        if files.is_empty() {
            return Ok(());
        }
        let pull_request_id = self.node_id(number).await?;
        // One aliased document per burst: top-level mutation fields run in
        // write order, so the last word about a path is the one that sticks.
        for chunk in files.chunks(FILES_VIEWED_PER_REQUEST) {
            let viewed: Vec<bool> = chunk.iter().map(|f| f.viewed).collect();
            let mut vars = serde_json::Map::new();
            vars.insert("pullRequestId".into(), json!(pull_request_id));
            for (i, file) in chunk.iter().enumerate() {
                vars.insert(format!("path{i}"), json!(file.path));
            }
            self.write(&q::set_files_viewed(&viewed), Value::Object(vars))
                .await?;
        }
        Ok(())
    }

    pub async fn comment(&self, number: u64, body: &str) -> Result<(), PrError> {
        if body.trim().is_empty() {
            return Err(PrError::invalid("A comment needs some words."));
        }
        let subject_id = self.node_id(number).await?;
        self.write(
            q::ADD_COMMENT,
            json!({ "subjectId": subject_id, "body": body }),
        )
        .await
        .map(drop)
    }

    pub async fn reply_to_thread(&self, thread_id: &str, body: &str) -> Result<(), PrError> {
        if !parse::is_node_id(thread_id) {
            return Err(PrError::invalid("That is not a review thread id."));
        }
        if body.trim().is_empty() {
            return Err(PrError::invalid("A reply needs some words."));
        }
        self.write(
            q::ADD_REVIEW_THREAD_REPLY,
            json!({ "threadId": thread_id, "body": body }),
        )
        .await
        .map(drop)
    }

    pub async fn resolve_thread(&self, thread_id: &str, resolved: bool) -> Result<(), PrError> {
        if !parse::is_node_id(thread_id) {
            return Err(PrError::invalid("That is not a review thread id."));
        }
        let mutation = if resolved {
            q::RESOLVE_REVIEW_THREAD
        } else {
            q::UNRESOLVE_REVIEW_THREAD
        };
        self.write(mutation, json!({ "threadId": thread_id }))
            .await
            .map(drop)
    }

    pub async fn react(
        &self,
        number: u64,
        subject_id: Option<&str>,
        content: PrReactionContent,
        reacted: bool,
    ) -> Result<(), PrError> {
        let subject_id = match subject_id {
            None => self.node_id(number).await?,
            Some(id) => {
                self.check_subject(number, id).await?;
                id.to_string()
            }
        };
        let mutation = if reacted {
            q::ADD_REACTION
        } else {
            q::REMOVE_REACTION
        };
        self.write(
            mutation,
            json!({ "subjectId": subject_id, "content": parse::github_reaction(content) }),
        )
        .await
        .map(drop)
    }

    /// A review, sent whole: GitHub's REST review endpoint takes the verdict,
    /// the summary and every line comment in one request, so a draft review
    /// lives on the client until it is sent.
    pub async fn submit_review(
        &self,
        number: u64,
        verdict: PrReviewVerdict,
        body: &str,
        comments: &[PrReviewCommentDraft],
    ) -> Result<(), PrError> {
        if verdict == PrReviewVerdict::RequestChanges && body.trim().is_empty() {
            return Err(PrError::invalid("Requesting changes needs a summary."));
        }
        let payload = parse::build_review_submission(verdict, body, comments);
        self.gh
            .rest_send(
                "POST",
                &self.repo_path(&format!("pulls/{number}/reviews")),
                Some(&payload),
            )
            .await
            .map(drop)
    }

    pub async fn update(
        &self,
        number: u64,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<(), PrError> {
        if title.is_none() && body.is_none() {
            return Ok(());
        }
        if title.is_some_and(|t| t.trim().is_empty()) {
            return Err(PrError::invalid("A pull request needs a title."));
        }
        let pull_request_id = self.node_id(number).await?;
        // A field the caller did not name is left out of the request, so
        // GitHub keeps the words that are there.
        let mut vars = serde_json::Map::new();
        vars.insert("pullRequestId".into(), json!(pull_request_id));
        if let Some(title) = title {
            vars.insert("title".into(), json!(title));
        }
        if let Some(body) = body {
            vars.insert("body".into(), json!(body));
        }
        self.write(q::UPDATE_PULL_REQUEST, Value::Object(vars))
            .await
            .map(drop)
    }

    pub async fn request_reviewers(
        &self,
        number: u64,
        reviewers: &[PrReviewerRef],
        requested: bool,
    ) -> Result<(), PrError> {
        if reviewers.is_empty() {
            return Ok(());
        }
        self.gh
            .rest_send(
                if requested { "POST" } else { "DELETE" },
                &self.repo_path(&format!("pulls/{number}/requested_reviewers")),
                Some(&parse::build_reviewer_request(reviewers)),
            )
            .await
            .map(drop)
    }

    pub async fn set_labels(
        &self,
        number: u64,
        labels: &[String],
        applied: bool,
    ) -> Result<(), PrError> {
        let labels: Vec<&String> = labels.iter().filter(|l| !l.trim().is_empty()).collect();
        if labels.is_empty() {
            return Ok(());
        }
        let issue = self.repo_path(&format!("issues/{number}/labels"));
        if applied {
            return self
                .gh
                .rest_send("POST", &issue, Some(&json!({ "labels": labels })))
                .await
                .map(drop);
        }
        for label in labels {
            match self
                .gh
                .rest_send(
                    "DELETE",
                    &format!("{issue}/{}", encode_component(label)),
                    None,
                )
                .await
            {
                // Already off, which is what was asked for.
                Ok(_) | Err(PrError::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub async fn action(&self, number: u64, input: &PrActionInput) -> Result<(), PrError> {
        let simple = match input.action {
            PrAction::DisableAutoMerge => Some(q::DISABLE_AUTO_MERGE),
            PrAction::Ready => Some(q::MARK_READY_FOR_REVIEW),
            PrAction::Draft => Some(q::CONVERT_TO_DRAFT),
            PrAction::Close => Some(q::CLOSE_PULL_REQUEST),
            PrAction::Reopen => Some(q::REOPEN_PULL_REQUEST),
            _ => None,
        };
        if let Some(mutation) = simple {
            let pull_request_id = self.node_id(number).await?;
            return self
                .write(mutation, json!({ "pullRequestId": pull_request_id }))
                .await
                .map(drop);
        }
        match input.action {
            PrAction::DeleteBranch => self.delete_branch(number).await,
            PrAction::UpdateBranch | PrAction::Merge | PrAction::EnableAutoMerge => {
                self.merge_or_update(number, input).await
            }
            _ => unreachable!("simple actions return above"),
        }
    }

    /// Merging and updating act on the head as it stands now, and a merge
    /// queue decides which mutation a merge is, so both read fresh.
    async fn merge_or_update(&self, number: u64, input: &PrActionInput) -> Result<(), PrError> {
        let data = self
            .read(
                q::PULL_REQUEST_ACTION_STATE,
                self.vars(
                    number,
                    json!({ "headRef": format!("refs/pull/{number}/head") }),
                ),
            )
            .await?;
        let state = not_found_or(
            data.get("repository")
                .and_then(|r| r.get("pullRequest"))
                .filter(|p| !p.is_null())
                .cloned(),
        )?;
        let id = not_found_or(parse::trimmed(state.get("id")))?;
        let head = parse::trimmed(state.get("headRefOid"));
        if input.action == PrAction::UpdateBranch {
            let behind = state
                .get("baseRef")
                .and_then(|b| b.get("compare"))
                .and_then(|c| c.get("behindBy"))
                .and_then(Value::as_u64);
            if behind == Some(0) {
                return Ok(());
            }
            let head =
                head.ok_or_else(|| PrError::failed("The pull request has no head commit."))?;
            // GitHub updates with a merge commit unless asked to rebase.
            let method = match input.update_method {
                Some(PrUpdateMethod::Rebase) => "REBASE",
                _ => "MERGE",
            };
            return self
                .write(
                    q::UPDATE_PULL_REQUEST_BRANCH,
                    json!({ "pullRequestId": id, "expectedHeadOid": head, "updateMethod": method }),
                )
                .await
                .map(drop);
        }
        // Merge queues always use auto-merge. A pull request that became
        // ready since its detail loaded merges directly, as
        // `gh pr merge --auto` does.
        let queued = state.get("isMergeQueueEnabled").and_then(Value::as_bool) == Some(true);
        let merge_state = parse::trimmed(state.get("mergeStateStatus"));
        let auto = queued
            || (input.action == PrAction::EnableAutoMerge
                && !parse::is_immediately_mergeable(merge_state.as_deref()));
        let merge = json!({
            "pullRequestId": id,
            "mergeMethod": parse::graphql_merge_method(input.merge_method.unwrap_or(PrMergeMethod::Merge)),
        });
        let mutation = if auto {
            q::ENABLE_AUTO_MERGE
        } else {
            q::MERGE_PULL_REQUEST
        };
        self.write(mutation, json!({ "input": merge }))
            .await
            .map(drop)
    }

    /// Deletes a closed pull request's source branch, only while it is
    /// neither the default branch nor moved on since the pull request last
    /// saw it.
    async fn delete_branch(&self, number: u64) -> Result<(), PrError> {
        let data = self
            .read(
                q::PULL_REQUEST_BRANCH_TO_DELETE,
                self.vars(number, json!({})),
            )
            .await?;
        let branch = not_found_or(
            data.get("repository")
                .and_then(|r| r.get("pullRequest"))
                .filter(|p| !p.is_null())
                .cloned(),
        )?;
        let field = |key: &str| parse::trimmed(branch.get(key));
        if field("state").is_some_and(|s| s.eq_ignore_ascii_case("OPEN")) {
            return Err(PrError::invalid(
                "The branch of an open pull request is not deleted.",
            ));
        }
        let repository_id = parse::trimmed(branch.get("headRepository").and_then(|r| r.get("id")));
        let (Some(repository_id), Some(head_name), Some(head_oid)) =
            (repository_id, field("headRefName"), field("headRefOid"))
        else {
            return Err(PrError::Unsupported {
                message: "The source branch is no longer available.".into(),
            });
        };
        if Some(&head_name) == field("baseRefName").as_ref() {
            return Err(PrError::invalid("That branch is the pull request's base."));
        }
        let qualified = format!("refs/heads/{head_name}");
        let source = self
            .read(
                q::PULL_REQUEST_SOURCE_BRANCH,
                json!({ "repositoryId": repository_id, "ref": qualified }),
            )
            .await?;
        let repository = source
            .get("node")
            .filter(|n| n.get("__typename").and_then(Value::as_str) == Some("Repository"))
            .ok_or(PrError::Unsupported {
                message: "The source branch is no longer available.".into(),
            })?;
        let current = repository.get("ref").filter(|r| !r.is_null());
        // Already gone, which is what was asked for.
        let Some(current) = current else {
            return Ok(());
        };
        let default = parse::trimmed(
            repository
                .get("defaultBranchRef")
                .and_then(|d| d.get("name")),
        );
        if default.is_none() || default.as_deref() == Some(head_name.as_str()) {
            return Err(PrError::invalid("That branch is the repository's default."));
        }
        if parse::trimmed(current.get("target").and_then(|t| t.get("oid"))).as_deref()
            != Some(head_oid.as_str())
        {
            return Err(PrError::invalid(
                "The branch has moved on since the pull request last saw it.",
            ));
        }
        self.write(
            q::DELETE_PULL_REQUEST_BRANCH,
            json!({
                "input": {
                    "repositoryId": repository_id,
                    "refUpdates": [{ "name": qualified, "beforeOid": head_oid, "afterOid": EMPTY_OID }],
                }
            }),
        )
        .await
        .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_are_encoded_like_encode_uri_component() {
        assert_eq!(encode_component("a b/c"), "a%20b%2Fc");
        assert_eq!(encode_path("src/a b/ü.ts"), "src/a%20b/%C3%BC.ts");
        assert_eq!(encode_component("bug: fix"), "bug%3A%20fix");
        assert_eq!(encode_component("(ok)*"), "(ok)*");
    }
}
