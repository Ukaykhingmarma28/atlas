// The fake repository: a dirty working tree, a branch list, a stash, a commit
// graph, and real diffs for every changed file.
//
// The default scenario used to report a clean repo, which left the whole git
// column — status, graph, and the side-by-side diff view — with nothing to
// draw. The diff view is the most theme-sensitive surface Atlas has (added,
// removed, modified and context lines each get their own background, and the
// word-level `emph` spans sit on top of syntax highlighting), so it needs a
// working tree with all four line kinds in it before any theme work can be
// reviewed.
//
// HEAD content is derived from the working-tree text in `files.ts` by named
// substitutions rather than being pasted a second time: `atHead` throws when a
// substitution stops matching, so editing a fixture file can't silently turn a
// diff into a no-op.

import type { BlameLine } from "@/features/git/lib/git-blame-api";
import type { CommitFile, DiffLineStatus, FileDiff } from "@/features/git/lib/git-diff-api";
import type { BuiltGraph, CommitRow, LaneSegment } from "@/features/git/lib/git-graph";
import type {
  BranchInfo,
  CommitDetail,
  InProgress,
  StashEntry,
} from "@/features/git/stores/git-store";
import type { GitSummary } from "@/features/workspaces/stores/workspace-git-store";
import type { MockHandlers } from "../types";
import { ALL_WORKSPACES, MOCK_WORKSPACE } from "../workspace";
import { binaryFileDiff, buildFileDiff, lineStatusOf, unifiedDiff } from "./diff";
import { fileText } from "./files";

/**
 * `git_list_branches`' row shape. Declared inline in `git-store.ts` rather
 * than exported, so it is restated here (Rust: `commands/git.rs`).
 */
interface GitBranch {
  name: string;
  is_current: boolean;
}

/**
 * One Session attributed to a commit, shown under the commit detail. Also
 * declared inline (`history-view.tsx`), and also `null`-unsafe there, so the
 * whole commit view goes down when this command is unanswered.
 */
interface CommitSession {
  sessionId: string;
  title: string | null;
  messageCount: number;
  toolCallCount: number;
  files: string[];
}

/** Apply ordered substitutions, refusing to produce a no-op diff silently. */
function atHead(rel: string, edits: [find: string, replace: string][]): string {
  let text = fileText(rel);
  if (!text) throw new Error(`[mock-backend] no working-tree text for ${rel}`);
  for (const [find, replace] of edits) {
    if (!text.includes(find)) {
      throw new Error(
        `[mock-backend] HEAD fixture for ${rel} no longer matches: ${find.slice(0, 40)}`,
      );
    }
    text = text.replace(find, replace);
  }
  return text;
}

// ── HEAD content ──────────────────────────────────────────────────────────

const HEAD_API_TS = () =>
  atHead("src/lib/api.ts", [
    // Removed in HEAD → shows as added lines.
    [
      `  createdAt: z.coerce.date(),\n  plan: z.enum(["free", "team", "enterprise"]),\n`,
      `  createdAt: z.coerce.date(),\n`,
    ],
    // Modified lines → `changed` rows with word-level spans.
    [
      `const BASE = import.meta.env.VITE_API_BASE ?? "https://api.acme.dev";`,
      `const BASE = "https://api.acme.dev";`,
    ],
    [`    credentials: "include",\n`, ``],
    [
      `    throw new ApiError(res.status, \`\${init?.method ?? "GET"} \${path} failed\`);`,
      `    throw new Error("request failed");`,
    ],
    [
      `  listUsers: (page = 0, size = 50) => request<User[]>(\`/users?page=\${page}&size=\${size}\`),`,
      `  listUsers: () => request<User[]>("/users"),`,
    ],
    // The whole retry helper is new work → a run of added lines.
    [
      `\n/** Retry a request with exponential backoff — 5xx and network errors only. */`,
      `\n/* TODO(ACME-1184): retry 5xx here. */`,
    ],
  ])
    .replace(/export async function withRetry[\s\S]*$/, "")
    .trimEnd() + "\n";

const HEAD_LIB_RS = () =>
  atHead("src-tauri/src/lib.rs", [
    [`use std::collections::BTreeMap;\n`, `use std::collections::HashMap;\n`],
    [`    users: Mutex<BTreeMap<String, User>>,`, `    users: Mutex<HashMap<String, User>>,`],
    [
      `        let mut guard = self.users.lock().expect("cache poisoned");\n        guard.insert(user.id.clone(), user)`,
      `        let mut guard = self.users.lock().unwrap();\n        guard.insert(user.id.clone(), user)`,
    ],
    // Removed in HEAD → added lines in the working tree.
    [
      `    pub fn len(&self) -> usize {\n        self.users.lock().map(|g| g.len()).unwrap_or(0)\n    }\n`,
      ``,
    ],
    [
      `#[tauri::command]\npub async fn seat_limit(plan: Plan) -> Result<Option<u32>, String> {\n    Ok(plan.seat_limit())\n}\n\n`,
      ``,
    ],
  ]);

const HEAD_TOKENS_CSS = () =>
  atHead("src/styles/tokens.css", [
    [`  --accent: #6e9cff;`, `  --accent: #4f7fe0;`],
    [`  --danger: #f2555a;\n`, ``],
    [`  --font-mono: "JetBrains Mono", ui-monospace, monospace;\n`, ``],
    [`.card[data-state="disabled"] {\n  opacity: 0.45;\n  pointer-events: none;\n}\n`, ``],
  ]);

const HEAD_README_MD = () =>
  atHead("README.md", [
    [`| \`src/styles\` | Design tokens — the only place raw colours appear |\n`, ``],
    [
      `- Every colour is a token in \`src/styles/tokens.css\`. No hex literals in JSX.`,
      `- Keep colours in one place.`,
    ],
  ]);

/** Deleted in the working tree — its diff is every line removed. */
const LEGACY_AUTH_TS = `import { api } from "./api";

/** @deprecated Session cookies replaced this in 2.3. Delete after ACME-1184. */
export function readLegacyToken(): string | null {
  const raw = window.localStorage.getItem("acme.token");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(atob(raw.split(".")[1] ?? "")) as { exp?: number };
    if (parsed.exp && parsed.exp * 1000 < Date.now()) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function migrateLegacySession(): Promise<boolean> {
  const token = readLegacyToken();
  if (!token) return false;
  await api.listUsers();
  window.localStorage.removeItem("acme.token");
  return true;
}
`;

// ── working-tree status ───────────────────────────────────────────────────

interface FakeChange {
  path: string;
  status: string;
  staged: boolean;
  /** Old and new text; `null` on either side means created / deleted. */
  before: () => string;
  after: () => string;
  binary?: boolean;
}

const CHANGES: FakeChange[] = [
  {
    path: "src/lib/api.ts",
    status: "modified",
    staged: false,
    before: HEAD_API_TS,
    after: () => fileText("src/lib/api.ts"),
  },
  {
    path: "src-tauri/src/lib.rs",
    status: "modified",
    staged: false,
    before: HEAD_LIB_RS,
    after: () => fileText("src-tauri/src/lib.rs"),
  },
  {
    path: "src/styles/tokens.css",
    status: "modified",
    staged: true,
    before: HEAD_TOKENS_CSS,
    after: () => fileText("src/styles/tokens.css"),
  },
  {
    path: "README.md",
    status: "modified",
    staged: true,
    before: HEAD_README_MD,
    after: () => fileText("README.md"),
  },
  {
    path: "src/components/badge.tsx",
    status: "untracked",
    staged: false,
    before: () => "",
    after: () => fileText("src/components/badge.tsx"),
  },
  {
    path: "src/legacy/auth.ts",
    status: "deleted",
    staged: true,
    before: () => LEGACY_AUTH_TS,
    after: () => "",
  },
  {
    path: "public/logo.png",
    status: "modified",
    staged: false,
    before: () => "",
    after: () => "",
    binary: true,
  },
];

/** Staged-ness is the one thing the panel mutates, so it lives apart. */
const staged = new Map(CHANGES.map((change) => [change.path, change.staged]));

const changeFor = (file: string) => CHANGES.find((change) => change.path === file);

function diffFor(file: string): FileDiff {
  const change = changeFor(file);
  if (change) {
    return change.binary
      ? binaryFileDiff(file)
      : buildFileDiff(change.before(), change.after(), file);
  }
  // Not a file this fixture tracks as dirty (another scenario's status, say):
  // show it as if its first line had just been added, rather than blank.
  const text = fileText(file);
  return buildFileDiff(text.split("\n").slice(1).join("\n"), text, file);
}

// ── branches, stashes, commits ────────────────────────────────────────────

const BRANCHES: BranchInfo[] = [
  {
    name: "main",
    isCurrent: true,
    isRemote: false,
    upstream: "origin/main",
    ahead: 3,
    behind: 1,
    subject: "feat(api): move user reads onto /v2",
    date: "2026-09-17T09:12:00Z",
  },
  {
    name: "feature/auth-v2",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/feature/auth-v2",
    ahead: 0,
    behind: 4,
    subject: "Switch API client to v2 endpoints",
    date: "2026-09-16T17:40:00Z",
  },
  {
    name: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
    isCurrent: false,
    isRemote: false,
    // No upstream yet — the "publish branch" affordance.
    upstream: null,
    ahead: 12,
    behind: 0,
    subject:
      "chore(deps): bump every design-token package and regenerate the palette, including the dark-mode ramp",
    date: "2026-09-15T08:05:00Z",
  },
  {
    name: "fix/pdf-annotations",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/fix/pdf-annotations",
    ahead: 0,
    behind: 0,
    subject: "fix(pdf): keep highlight rects on rotate",
    date: "2026-09-12T14:22:00Z",
  },
  {
    name: "origin/main",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: "feat(api): move user reads onto /v2",
    date: "2026-09-17T09:12:00Z",
  },
  {
    name: "origin/feature/auth-v2",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: "Switch API client to v2 endpoints",
    date: "2026-09-16T17:40:00Z",
  },
];

const INITIAL_STASHES: StashEntry[] = [
  { index: 0, message: "WIP on main: 4f21a90 spike the token ramp", branch: "main" },
  {
    index: 1,
    message: "On feature/auth-v2: half-finished refresh-token flow",
    branch: "feature/auth-v2",
  },
  {
    index: 2,
    message:
      "On main: experiment — every surface on the shadcn base tokens before the derived keys land",
    branch: "main",
  },
];

let stashes: StashEntry[] = INITIAL_STASHES.map((stash) => ({ ...stash }));

interface FakeCommit {
  sha: string;
  message: string;
  author: string;
  email: string;
  date: string;
  /** Parents, newest-first in this list; a second parent makes it a merge. */
  parents: string[];
  lane: number;
  refs: CommitRow["refs"];
  files: CommitFile[];
}

const LANE_COLORS = ["#6e9cff", "#b07bff", "#4bd1a0", "#f2b955", "#f2555a"];

const COMMITS: FakeCommit[] = [
  {
    sha: "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0",
    message: "feat(api): move user reads onto /v2",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-17T09:12:00Z",
    parents: ["9a1c2b3d4e5f60718293a4b5c6d7e8f901234567"],
    lane: 0,
    refs: [
      { name: "main", kind: "branch", isCurrent: true },
      { name: "origin/main", kind: "remote", isCurrent: false },
    ],
    files: [
      { path: "src/lib/api.ts", status: "M" },
      { path: "src/lib/utils.ts", status: "M" },
    ],
  },
  {
    sha: "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567",
    message: "Merge branch 'fix/pdf-annotations'",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-16T18:02:00Z",
    parents: [
      "1b2c3d4e5f60718293a4b5c6d7e8f9012345678a",
      "c0ffee11223344556677889900aabbccddeeff01",
    ],
    lane: 0,
    refs: [],
    files: [{ path: "src/components/header.tsx", status: "M" }],
  },
  {
    sha: "c0ffee11223344556677889900aabbccddeeff01",
    message: "fix(pdf): keep highlight rects on rotate",
    author: "Priya Raman",
    email: "priya@acme.dev",
    date: "2026-09-16T11:48:00Z",
    parents: ["1b2c3d4e5f60718293a4b5c6d7e8f9012345678a"],
    lane: 1,
    refs: [{ name: "fix/pdf-annotations", kind: "branch", isCurrent: false }],
    files: [{ path: "src/components/button.tsx", status: "M" }],
  },
  {
    sha: "1b2c3d4e5f60718293a4b5c6d7e8f9012345678a",
    message: "refactor(tokens): one source of truth for colour",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-15T16:30:00Z",
    parents: ["2c3d4e5f60718293a4b5c6d7e8f9012345678abc"],
    lane: 0,
    refs: [{ name: "v2.4.1", kind: "tag", isCurrent: false }],
    files: [{ path: "src/styles/tokens.css", status: "M" }],
  },
  {
    sha: "2c3d4e5f60718293a4b5c6d7e8f9012345678abc",
    message: "chore: drop the legacy token reader",
    author: "Sam Okafor",
    email: "sam@acme.dev",
    date: "2026-09-14T10:15:00Z",
    parents: ["3d4e5f60718293a4b5c6d7e8f9012345678abcde"],
    lane: 0,
    refs: [],
    files: [{ path: "src/legacy/auth.ts", status: "D" }],
  },
  {
    sha: "3d4e5f60718293a4b5c6d7e8f9012345678abcde",
    message:
      "feat(admin): paginate the user table, add the plan column, and stop refetching on window focus",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-12T13:05:00Z",
    parents: ["4e5f60718293a4b5c6d7e8f9012345678abcdef0"],
    lane: 0,
    refs: [],
    files: [
      { path: "src/main.tsx", status: "M" },
      { path: "src/lib/api.ts", status: "M" },
    ],
  },
  {
    sha: "4e5f60718293a4b5c6d7e8f9012345678abcdef0",
    message: "build: move to Vite 6",
    author: "Priya Raman",
    email: "priya@acme.dev",
    date: "2026-09-09T09:41:00Z",
    parents: ["5f60718293a4b5c6d7e8f9012345678abcdef012"],
    lane: 0,
    refs: [],
    files: [
      { path: "package.json", status: "M" },
      { path: "tsconfig.json", status: "M" },
    ],
  },
  {
    sha: "5f60718293a4b5c6d7e8f9012345678abcdef012",
    message: "docs: rewrite the README layout table",
    author: "Sam Okafor",
    email: "sam@acme.dev",
    date: "2026-09-05T15:20:00Z",
    parents: [],
    lane: 0,
    refs: [{ name: "v2.4.0", kind: "tag", isCurrent: false }],
    files: [{ path: "README.md", status: "M" }],
  },
];

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * A commit's diff. Files that are also dirty in the working tree reuse that
 * change (one fixture, two surfaces); the rest get a synthetic "this commit
 * introduced the first line" diff so no commit opens empty.
 */
function commitDiff(commit: FakeCommit): string {
  return commit.files
    .map((file) => {
      const change = changeFor(file.path);
      if (change && !change.binary) return unifiedDiff(change.before(), change.after(), file.path);
      if (file.status === "D") return unifiedDiff(LEGACY_AUTH_TS, "", file.path);
      const text = fileText(file.path);
      return unifiedDiff(text.split("\n").slice(1).join("\n"), text, file.path);
    })
    .join("");
}

function graph(): BuiltGraph {
  const laneCount = Math.max(...COMMITS.map((commit) => commit.lane)) + 1;
  const rows: CommitRow[] = COMMITS.map((commit, index) => {
    const segments: LaneSegment[] = [];
    const color = LANE_COLORS[commit.lane % LANE_COLORS.length];
    // Incoming edge from the row above, unless this is the first row.
    if (index > 0) {
      segments.push({ fromLane: commit.lane, toLane: commit.lane, fromY: 0, toY: 0.5, color });
    }
    for (const parent of commit.parents) {
      const target = COMMITS.find((candidate) => candidate.sha === parent);
      if (!target) continue;
      segments.push({
        fromLane: commit.lane,
        toLane: target.lane,
        fromY: 0.5,
        toY: 1,
        color: LANE_COLORS[target.lane % LANE_COLORS.length],
      });
    }
    return {
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      message: commit.message,
      author: commit.author,
      email: commit.email,
      date: commit.date,
      refs: commit.refs,
      isHead: index === 0,
      commitLane: commit.lane,
      commitColor: color,
      segments,
    };
  });
  return { rows, laneCount };
}

/** Per-line blame for the editor's inline annotation. */
function blame(file: string): BlameLine[] {
  const text = fileText(file);
  if (!text) return [];
  const change = changeFor(file);
  const lineCount = text.replace(/\n$/, "").split("\n").length;
  const touched = new Set(change && !change.binary ? lineStatusOf(diffFor(file)).changed : []);
  const added = new Set(change && !change.binary ? lineStatusOf(diffFor(file)).added : []);
  return Array.from({ length: lineCount }, (_, i) => {
    const line = i + 1;
    // Uncommitted lines are the ones this working tree changed.
    if (touched.has(line) || added.has(line)) {
      return {
        line,
        sha: "0000000000000000000000000000000000000000",
        shortSha: "0000000",
        author: "Not Committed Yet",
        timeMs: 0,
        summary: "Uncommitted changes",
        committed: false,
      };
    }
    const commit = COMMITS[(line * 7) % COMMITS.length];
    return {
      line,
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      author: commit.author,
      timeMs: Date.parse(commit.date),
      summary: commit.message,
      committed: true,
    };
  });
}

// ── handlers ──────────────────────────────────────────────────────────────

/** Per-workspace summaries: a dirty repo, a clean one, and a non-repo. */
const SUMMARIES: Record<string, GitSummary> = {
  [MOCK_WORKSPACE.path]: {
    isRepo: true,
    branch: "main",
    headSubject: "feat(api): move user reads onto /v2",
    dirty: true,
    additions: 96,
    deletions: 41,
  },
  [ALL_WORKSPACES[1].path]: {
    isRepo: true,
    branch: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
    headSubject: "chore(deps): bump every design-token package and regenerate the palette",
    dirty: false,
    additions: 0,
    deletions: 0,
  },
  [ALL_WORKSPACES[2].path]: {
    isRepo: false,
    branch: "",
    headSubject: "",
    dirty: false,
    additions: 0,
    deletions: 0,
  },
};

const noProgress: InProgress = { merge: false, rebase: false, cherryPick: false, revert: false };

export const gitHandlers: MockHandlers = {
  git_watch_start: () => null,
  git_workspace_summary: ({ path }): GitSummary =>
    SUMMARIES[String(path)] ?? {
      isRepo: false,
      branch: "",
      headSubject: "",
      dirty: false,
      additions: 0,
      deletions: 0,
    },
  git_snapshot: () => ({
    isRepo: true,
    branch: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 3,
    behind: 1,
    files: CHANGES.map((change) => ({
      path: change.path,
      status: change.status,
      staged: staged.get(change.path) ?? false,
      conflicted: false,
    })),
    branches: BRANCHES,
    stashes,
    inProgress: null,
  }),
  git_inprogress: (): InProgress => noProgress,
  git_branches_full: (): BranchInfo[] => BRANCHES,
  git_list_branches: (): GitBranch[] =>
    BRANCHES.filter((branch) => !branch.isRemote).map((branch) => ({
      name: branch.name,
      is_current: branch.isCurrent,
    })),
  git_stash_list: (): StashEntry[] => stashes,
  git_stash_drop: ({ index }): null => {
    stashes = stashes.filter((stash) => stash.index !== Number(index));
    return null;
  },
  git_stash_pop: ({ index }): null => {
    stashes = stashes.filter((stash) => stash.index !== Number(index));
    return null;
  },
  git_stash_apply: () => null,
  git_stash_push: ({ message }): null => {
    stashes = [
      { index: 0, message: String(message ?? "WIP on main"), branch: "main" },
      ...stashes.map((stash) => ({ ...stash, index: stash.index + 1 })),
    ];
    return null;
  },
  git_remotes: () => [
    { name: "origin", url: "git@github.com:acme/acme-app.git" },
    { name: "upstream", url: "https://github.com/acme-oss/acme-app.git" },
  ],
  git_tags: () => ["v2.4.1", "v2.4.0", "v2.3.7", "v2.3.6"],

  git_log: () =>
    COMMITS.map((commit) => ({
      hash: commit.sha,
      short_hash: shortSha(commit.sha),
      message: commit.message,
      author: commit.author,
      date: commit.date,
    })),
  git_show: ({ sha }): CommitDetail => {
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(String(sha)));
    if (!commit) throw new Error(`bad object ${String(sha)}`);
    const [subject, ...rest] = commit.message.split("\n");
    return {
      hash: commit.sha,
      shortHash: shortSha(commit.sha),
      author: commit.author,
      email: commit.email,
      date: commit.date,
      subject,
      body: rest.join("\n"),
      diff: commitDiff(commit),
    };
  },
  // Most commits have no recorded Session (capture off, or human work), which
  // is the empty state; the two newest carry one so the panel is visible too.
  capture_commit_sessions: ({ commitSha }): CommitSession[] => {
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(String(commitSha)));
    if (!commit || COMMITS.indexOf(commit) > 1) return [];
    return [
      {
        sessionId: `sess-${shortSha(commit.sha)}`,
        title: commit.message.split("\n")[0],
        messageCount: 24,
        toolCallCount: 61,
        files: commit.files.map((file) => file.path),
      },
    ];
  },
  git_commit_changed_files: ({ sha }): CommitFile[] =>
    COMMITS.find((commit) => commit.sha.startsWith(String(sha)))?.files ?? [],

  git_graph_signature: (): string => `${COMMITS[0].sha}:${BRANCHES.length}:${stashes.length}`,
  git_graph_build: (): BuiltGraph => graph(),

  git_diff_structured: ({ file }): FileDiff => diffFor(String(file)),
  diff_structured_text: ({ oldText, newText, file }): FileDiff =>
    buildFileDiff(String(oldText ?? ""), String(newText ?? ""), String(file)),
  git_diff_line_status: ({ file }): DiffLineStatus => lineStatusOf(diffFor(String(file))),
  git_diff_file: ({ file }): string => {
    const change = changeFor(String(file));
    if (!change || change.binary) return "";
    return unifiedDiff(change.before(), change.after(), change.path);
  },
  git_diff_all: (): string =>
    CHANGES.filter((change) => !change.binary)
      .map((change) => unifiedDiff(change.before(), change.after(), change.path))
      .join(""),
  git_blame_file: ({ file }): BlameLine[] => blame(String(file)),

  git_stage: ({ files }): null => {
    for (const file of (files ?? []) as string[]) staged.set(file, true);
    return null;
  },
  git_unstage: ({ files }): null => {
    for (const file of (files ?? []) as string[]) staged.set(file, false);
    return null;
  },
};
