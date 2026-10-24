// The pull-request surface (`commands/pull_requests`), faked for a browser.
//
// One fake repository, `northwind/northwind-shop`, answered for every
// checkout so the surface can be built against any scenario. Its pull
// requests are picked to cover the states the UI has to draw:
//
//  - #412 — open and big: 140 files across two pages of the files API, its
//    whole patch past what the host sends in one piece, failing and pending
//    checks, review threads (one resolved, one outdated, one past the first
//    page of comments) and changes requested;
//  - #398 — merged, approved, every check green, a timeline to page through;
//  - #405 — a draft, no checks yet, a team asked to review;
//  - #401 — open with a merge conflict and a failing required check;
//  - #377 — closed without merging.
//
// Writes are real for the life of the page: ticking a file viewed, resolving
// a thread, reacting, commenting and merging all change the next read. Like
// Rust, a failure rejects with a `PrError` object.

import type {
  PrActivity,
  PrActor,
  PrCapabilities,
  PrCheck,
  PrComment,
  PrCommit,
  PrCommitsPage,
  PrDetail,
  PrDiffFile,
  PrDiffFileContents,
  PrDiffResult,
  PrError,
  PrFilesViewed,
  PrFileViewed,
  PrImage,
  PrListEntry,
  PrListResult,
  PrProvider,
  PrReaction,
  PrReactionContent,
  PrReviewThread,
  PrThreadComment,
  PrThreadCommentsPage,
  PrTimelineItem,
  PrTimelinePage,
  PrViewerPermissions,
} from "@/features/pull-requests/lib/pull-requests-types";
import type { MockArgs, TypedHandlers, Unit } from "../types";

function fail(error: PrError): never {
  // oxlint-disable-next-line no-throw-literal -- Rust's `Err(PrError)`, a plain object.
  throw error;
}

const NOW = Date.parse("2026-10-20T15:00:00Z");
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const REPOSITORY = "northwind/northwind-shop";
const URL_BASE = `https://github.com/${REPOSITORY}/pull`;
const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;

const actor = (login: string, name: string | null, id: number, isBot = false): PrActor => ({
  login,
  name,
  avatarUrl: avatar(id),
  isBot,
});

const VIEWER = actor("mara-k", "Mara Kovač", 1001);
const DEV = actor("theo-r", "Theo Ruiz", 1002);
const REVIEWER = actor("ines-p", "Inês Pereira", 1003);
const BOT = actor("northwind-ci", null, 1004, true);

const CAPABILITIES: PrCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  viewedFiles: "host",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: false },
  labels: true,
  fileContents: true,
  conditionalReads: true,
};

const PROVIDER: PrProvider = {
  kind: "github",
  host: "github.com",
  repository: REPOSITORY,
  viewer: VIEWER.login,
  capabilities: CAPABILITIES,
};

function permissions(open: boolean, authored: boolean): PrViewerPermissions {
  return {
    actions: open
      ? [
          "merge",
          "enable-auto-merge",
          "disable-auto-merge",
          "ready",
          "draft",
          "close",
          "update-branch",
        ]
      : ["delete-branch", "reopen"],
    comment: true,
    resolve: true,
    verdicts: authored ? ["comment"] : ["comment", "approve", "request-changes"],
    requestReviewers: true,
    updateMethods: open ? ["merge", "rebase"] : [],
    labels: true,
    editChangeRequest: true,
    canMerge: open,
  };
}

const check = (
  name: string,
  status: PrCheck["status"],
  minutes: number | null,
  extra: Partial<PrCheck> = {},
): PrCheck => ({
  name,
  status,
  description: null,
  url: `https://github.com/${REPOSITORY}/actions/runs/${name.length * 7919}`,
  required: null,
  workflow: "CI",
  startedAt: iso(2),
  completedAt: minutes === null ? null : iso(2 - minutes / 60),
  durationMs: minutes === null ? null : minutes * 60_000,
  ...extra,
});

// ── the pull requests ───────────────────────────────────────────────────────

interface FakePull {
  detail: PrDetail;
  entry: PrListEntry;
}

function pull(
  detail: Omit<PrDetail, "capabilities" | "repository" | "url" | "viewer" | "mergeCapabilities">,
): FakePull {
  const full: PrDetail = {
    ...detail,
    capabilities: CAPABILITIES,
    repository: REPOSITORY,
    url: `${URL_BASE}/${detail.number}`,
    viewer: VIEWER.login,
    mergeCapabilities: { merge: true, squash: true, rebase: false },
  };
  return {
    detail: full,
    entry: {
      number: full.number,
      title: full.title,
      url: full.url,
      author: full.author,
      headBranch: full.headBranch,
      baseBranch: full.baseBranch,
      state: full.state,
      isDraft: full.isDraft,
      mergeability: full.mergeability,
      additions: full.additions,
      deletions: full.deletions,
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
      viewerReviewRequested: full.reviewers.some(
        (r) => r.actor.login === VIEWER.login && r.state === "requested",
      ),
      labels: full.labels,
      reviewDecision: full.reviewDecision,
      checksState: full.checksState,
    },
  };
}

const BIG_FILES = 140;

const PULLS: FakePull[] = [
  pull({
    number: 412,
    title: "Checkout: split the payment step into a state machine",
    body: [
      "Replaces the payment step's nested `useEffect` chain with an explicit state machine.",
      "",
      "- `idle → authorising → confirming → done`, with `failed` reachable from each",
      "- retries are now a transition, not a re-render",
      "- the old step stays behind a flag for one release",
      "",
      "![State diagram](https://github.com/user-attachments/assets/7d0c9a3e-payment-states)",
    ].join("\n"),
    author: DEV,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "changes-requested",
    additions: 3214,
    deletions: 1876,
    changedFiles: BIG_FILES,
    commitCount: 23,
    headBranch: "theo/payment-state-machine",
    headRepository: REPOSITORY,
    headSha: "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012345",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: false,
    createdAt: iso(70),
    updatedAt: iso(1),
    mergedAt: null,
    closedAt: null,
    reviewers: [
      { actor: VIEWER, kind: "user", state: "requested" },
      { actor: REVIEWER, kind: "user", state: "changes-requested" },
    ],
    labels: [
      { name: "checkout", color: "0e8a16" },
      { name: "needs-tests", color: "d93f0b" },
    ],
    assignees: [DEV],
    checks: [
      check("e2e / checkout-flow", "failure", 14, { required: true, description: "3 failing" }),
      check("lint", "success", 1),
      check("unit", "success", 6, { required: true }),
      check("typecheck", "success", 2),
      check("preview deploy", "pending", null, { workflow: "Deploy" }),
    ],
    checksState: "failing",
    checksTruncated: false,
    viewerPermissions: permissions(true, false),
    baseComparison: "behind",
    behindBy: 4,
    autoMergeEnabled: false,
    autoMergeMethod: null,
  }),
  pull({
    number: 405,
    title: "Search: typo-tolerant product lookup",
    body: "Early sketch — not ready for review.",
    author: VIEWER,
    state: "open",
    isDraft: true,
    mergeability: "unknown",
    mergeStateStatus: "DRAFT",
    reviewDecision: null,
    additions: 212,
    deletions: 18,
    changedFiles: 6,
    commitCount: 3,
    headBranch: "mara/fuzzy-search",
    headRepository: REPOSITORY,
    headSha: "4b5c6d7e8f90123459f2c4e7a1b3d5f607182930",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: false,
    createdAt: iso(20),
    updatedAt: iso(3),
    mergedAt: null,
    closedAt: null,
    reviewers: [
      {
        actor: { login: "northwind/search", name: "Search", avatarUrl: avatar(2001), isBot: false },
        kind: "team",
        state: "requested",
      },
    ],
    labels: [{ name: "search", color: "1d76db" }],
    assignees: [VIEWER],
    checks: [],
    checksState: null,
    checksTruncated: false,
    viewerPermissions: permissions(true, true),
    baseComparison: "up-to-date",
    behindBy: 0,
    autoMergeEnabled: false,
    autoMergeMethod: null,
  }),
  pull({
    number: 401,
    title: "Cart: persist coupons across sessions",
    body: "Coupons were held in memory only; they now survive a reload.",
    author: REVIEWER,
    state: "open",
    isDraft: false,
    mergeability: "conflicting",
    mergeStateStatus: "DIRTY",
    reviewDecision: "review-required",
    additions: 96,
    deletions: 41,
    changedFiles: 5,
    commitCount: 4,
    headBranch: "ines/persist-coupons",
    headRepository: "ines-p/northwind-shop",
    headSha: "7e8f90123459f2c4e7a1b3d5f6071829304b5c6d",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: true,
    createdAt: iso(48),
    updatedAt: iso(6),
    mergedAt: null,
    closedAt: null,
    reviewers: [{ actor: VIEWER, kind: "user", state: "requested" }],
    labels: [{ name: "cart", color: "fbca04" }],
    assignees: [],
    checks: [
      check("unit", "failure", 5, {
        required: true,
        description: "CouponStore › restores on load",
      }),
      check("lint", "success", 1),
    ],
    checksState: "failing",
    checksTruncated: false,
    viewerPermissions: permissions(true, false),
    baseComparison: "behind",
    behindBy: 12,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
  pull({
    number: 398,
    title: "Orders: show the delivery window on the receipt",
    body: "Adds the promised delivery window to the order receipt and its email.",
    author: DEV,
    state: "merged",
    isDraft: false,
    mergeability: "unknown",
    mergeStateStatus: null,
    reviewDecision: "approved",
    additions: 148,
    deletions: 22,
    changedFiles: 7,
    commitCount: 5,
    headBranch: "theo/delivery-window",
    headRepository: REPOSITORY,
    headSha: "c6d7e8f9012345a9f2c4e7a1b3d5f60718293a4b",
    baseBranch: "main",
    baseSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    isCrossRepository: false,
    createdAt: iso(120),
    updatedAt: iso(96),
    mergedAt: iso(96),
    closedAt: iso(96),
    reviewers: [{ actor: VIEWER, kind: "user", state: "approved" }],
    labels: [{ name: "orders", color: "5319e7" }],
    assignees: [DEV],
    checks: [check("unit", "success", 5), check("lint", "success", 1), check("e2e", "success", 12)],
    checksState: "passing",
    checksTruncated: false,
    viewerPermissions: permissions(false, false),
    baseComparison: "unknown",
    behindBy: null,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
  pull({
    number: 377,
    title: "Experiment: server-rendered category pages",
    body: "Closing in favour of the streaming approach.",
    author: DEV,
    state: "closed",
    isDraft: false,
    mergeability: "unknown",
    mergeStateStatus: null,
    reviewDecision: null,
    additions: 640,
    deletions: 310,
    changedFiles: 19,
    commitCount: 9,
    headBranch: "theo/ssr-categories",
    headRepository: REPOSITORY,
    headSha: "e8f9012345a9f2c4e7a1b3d5f60718293a4bc6d7",
    baseBranch: "main",
    baseSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    isCrossRepository: false,
    createdAt: iso(400),
    updatedAt: iso(300),
    mergedAt: null,
    closedAt: iso(300),
    reviewers: [],
    labels: [],
    assignees: [],
    checks: [check("unit", "success", 4)],
    checksState: "passing",
    checksTruncated: false,
    viewerPermissions: permissions(false, false),
    baseComparison: "unknown",
    behindBy: null,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
];

function find(number: unknown): FakePull {
  const found = PULLS.find((p) => p.detail.number === Number(number));
  return found ?? fail({ kind: "notFound" });
}

// ── conversation ────────────────────────────────────────────────────────────

const reactions = new Map<string, PrReaction[]>([
  [
    "IC_412_1",
    [{ content: "rocket", count: 2, actors: ["ines-p", "theo-r"], viewerHasReacted: false }],
  ],
]);

const threadComment = (
  id: string,
  author: PrActor,
  body: string,
  hoursAgo: number,
): PrThreadComment => ({
  id,
  author,
  body,
  createdAt: iso(hoursAgo),
  editedAt: null,
  url: `${URL_BASE}/412#discussion_${id}`,
  reactions: reactions.get(id) ?? [],
});

/** The long thread's comments past the ten the activity read carries. */
const LONG_THREAD_REST: PrThreadComment[] = Array.from({ length: 4 }, (_, i) =>
  threadComment(`RC_412_long_${i + 10}`, i % 2 ? DEV : REVIEWER, `Follow-up ${i + 1}.`, 20 - i),
);

const threads = new Map<number, PrReviewThread[]>([
  [
    412,
    [
      {
        id: "PRRT_412_retry",
        path: "src/checkout/payment-machine.ts",
        line: 88,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [
          threadComment(
            "RC_412_1",
            REVIEWER,
            "A retry from `failed` re-enters `authorising` without clearing the last error — the banner flashes the stale message.",
            30,
          ),
          threadComment("RC_412_2", DEV, "Good catch, clearing it on entry.", 28),
        ],
        commentCount: 2,
        nextCommentsCursor: null,
        canResolve: true,
      },
      {
        id: "PRRT_412_names",
        path: "src/checkout/payment-step.tsx",
        line: 14,
        side: "left",
        isResolved: true,
        isOutdated: false,
        comments: [threadComment("RC_412_3", VIEWER, "Nit: `PaymentStepLegacy`?", 40)],
        commentCount: 1,
        nextCommentsCursor: null,
        canResolve: true,
      },
      {
        id: "PRRT_412_old",
        path: "src/checkout/use-payment.ts",
        line: null,
        side: "right",
        isResolved: false,
        isOutdated: true,
        comments: [threadComment("RC_412_4", REVIEWER, "This hook goes away now, right?", 60)],
        commentCount: 1,
        nextCommentsCursor: null,
        canResolve: true,
      },
      {
        id: "PRRT_412_long",
        path: "src/checkout/payment-machine.test.ts",
        line: 120,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: Array.from({ length: 10 }, (_, i) =>
          threadComment(
            `RC_412_long_${i}`,
            i % 2 ? DEV : REVIEWER,
            i === 0 ? "These timers should use fake time." : `Reply ${i}.`,
            36 - i,
          ),
        ),
        commentCount: 10 + LONG_THREAD_REST.length,
        nextCommentsCursor: "long-2",
        canResolve: true,
      },
    ],
  ],
]);

const remarks = new Map<number, PrComment[]>([
  [
    412,
    [
      {
        id: "IC_412_1",
        kind: "issue-comment",
        author: DEV,
        body: "Ready for another look — the flag defaults off.",
        createdAt: iso(26),
        editedAt: null,
        url: `${URL_BASE}/412#issuecomment-1`,
        path: null,
        reviewState: null,
        reactions: reactions.get("IC_412_1") ?? [],
      },
      {
        id: "PRR_412_1",
        kind: "review",
        author: REVIEWER,
        body: "Close. The retry path needs a test before this lands.",
        createdAt: iso(24),
        editedAt: null,
        url: `${URL_BASE}/412#pullrequestreview-1`,
        path: null,
        reviewState: "CHANGES_REQUESTED",
        reactions: [],
      },
      {
        id: "IC_412_2",
        kind: "issue-comment",
        author: BOT,
        body: "Preview deploy queued.",
        createdAt: iso(2),
        editedAt: null,
        url: `${URL_BASE}/412#issuecomment-2`,
        path: null,
        reviewState: null,
        reactions: [],
      },
    ],
  ],
  [
    398,
    [
      {
        id: "PRR_398_1",
        kind: "review",
        author: VIEWER,
        body: "",
        createdAt: iso(97),
        editedAt: null,
        url: `${URL_BASE}/398#pullrequestreview-2`,
        path: null,
        reviewState: "APPROVED",
        reactions: [],
      },
    ],
  ],
]);

function commitsOf(number: number): PrCommit[] {
  const count = find(number).detail.commitCount;
  return Array.from({ length: count }, (_, i) => ({
    oid: (number * 1_000_003 + i).toString(16).padStart(8, "0").repeat(5),
    messageHeadline: i === count - 1 ? "Address review feedback" : `Step ${i + 1} of the change`,
    committedDate: iso(70 - i * 2),
    additions: i === 3 ? null : 40 + i * 7,
    deletions: i === 3 ? null : 5 + i,
    authors: [i % 4 === 3 ? VIEWER : (find(number).detail.author ?? DEV)],
  }));
}

function activity(number: number): PrActivity {
  const detail = find(number).detail;
  const own = threads.get(number) ?? [];
  const lineComments: PrComment[] = own.flatMap((t) =>
    t.comments.map((c) => ({
      ...c,
      kind: "review-comment" as const,
      path: t.path,
      reviewState: null,
    })),
  );
  const comments = [...(remarks.get(number) ?? []), ...lineComments]
    .map((c) => ({ ...c, reactions: reactions.get(c.id) ?? c.reactions }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    author: detail.author,
    reviewers: detail.reviewers.map((r) => r.actor),
    comments,
    commentCount: (remarks.get(number)?.length ?? 0) + own.reduce((n, t) => n + t.commentCount, 0),
    commentsTruncated: own.some((t) => t.nextCommentsCursor !== null),
    reviewThreadsTruncated: false,
    reviewThreads: own,
    commits: commitsOf(number),
    reactions: reactions.get(`PR_${number}`) ?? [],
  };
}

function timeline(number: number, cursor: string | null): PrTimelinePage {
  const detail = find(number).detail;
  const commits = commitsOf(number);
  const items: PrTimelineItem[] = [
    { kind: "opened", actor: detail.author, at: detail.createdAt },
    ...commits.map((c, i): PrTimelineItem => ({
      kind: "commit",
      id: `PRC_${number}_${i}`,
      oid: c.oid,
      messageHeadline: c.messageHeadline,
      authors: c.authors,
      at: c.committedDate,
    })),
    ...(detail.reviewers.length
      ? [
          {
            kind: "review-requested",
            id: `RRE_${number}`,
            actor: detail.author,
            reviewer: detail.reviewers[0].actor,
            at: iso(60),
          } satisfies PrTimelineItem,
        ]
      : []),
    ...(number === 412
      ? [
          {
            kind: "force-pushed",
            id: "HRFP_412",
            actor: DEV,
            beforeOid: "0".repeat(40),
            afterOid: detail.headSha,
            at: iso(5),
          } satisfies PrTimelineItem,
        ]
      : []),
    ...(detail.state === "merged"
      ? [
          {
            kind: "merged",
            id: `ME_${number}`,
            actor: VIEWER,
            commitOid: detail.headSha,
            baseBranch: detail.baseBranch,
            at: detail.mergedAt!,
          } satisfies PrTimelineItem,
          {
            kind: "head-ref-deleted",
            id: `HRD_${number}`,
            actor: VIEWER,
            at: detail.mergedAt!,
          } satisfies PrTimelineItem,
        ]
      : []),
    ...(detail.state === "closed"
      ? [
          {
            kind: "closed",
            id: `CE_${number}`,
            actor: DEV,
            at: detail.closedAt!,
          } satisfies PrTimelineItem,
        ]
      : []),
  ];
  // Pages of 20, so #412's history pages.
  const start = cursor ? Number(cursor) : 0;
  const page = items.slice(start, start + 20);
  return { items: page, nextCursor: start + 20 < items.length ? String(start + 20) : null };
}

// ── files and diffs ─────────────────────────────────────────────────────────

const DIRS = ["src/checkout", "src/checkout/steps", "src/cart", "src/ui", "tests/checkout"];

function filesOf(number: number): PrDiffFile[] {
  const detail = find(number).detail;
  return Array.from({ length: detail.changedFiles }, (_, i): PrDiffFile => {
    const dir = DIRS[i % DIRS.length];
    const status = i === 0 ? "added" : i === 1 ? "renamed" : i === 2 ? "removed" : "modified";
    return {
      path: i === 7 ? `${dir}/logo-${i}.png` : `${dir}/module-${i}.ts`,
      previousPath: status === "renamed" ? `${dir}/old-module-${i}.ts` : null,
      status,
      additions: status === "removed" ? 0 : 8 + (i % 13),
      deletions: status === "added" ? 0 : i % 6,
      // A binary file, and one past the host's patch limit.
      hasPatch: i !== 7 && i !== 11,
    };
  });
}

function hunkFor(file: PrDiffFile): string {
  if (file.status === "added") {
    return `@@ -0,0 +1,3 @@\n+export const created = true;\n+\n+export default created;\n`;
  }
  if (file.status === "removed") return `@@ -1,2 +0,0 @@\n-export const gone = true;\n-\n`;
  return [
    "@@ -10,6 +10,8 @@ export function step() {",
    "   const state = machine.current;",
    "-  if (state === 'failed') retry();",
    "+  if (state === 'failed') {",
    "+    machine.send({ type: 'retry' });",
    "+  }",
    "   return state;",
    " }",
    "",
  ].join("\n");
}

function patchFor(files: PrDiffFile[]): string {
  return files
    .map((f) => {
      const old = f.previousPath ?? f.path;
      const head = [`diff --git a/${old} b/${f.path}`];
      if (f.status === "added") head.push("new file mode 100644");
      if (f.status === "removed") head.push("deleted file mode 100644");
      if (f.status === "renamed") head.push(`rename from ${old}`, `rename to ${f.path}`);
      head.push(
        `--- ${f.status === "added" ? "/dev/null" : `a/${old}`}`,
        `+++ ${f.status === "removed" ? "/dev/null" : `b/${f.path}`}`,
      );
      return `${head.join("\n")}\n${f.hasPatch ? hunkFor(f) : ""}`;
    })
    .join("");
}

function diff(number: number, cursor: string | null, commit: string | null): PrDiffResult {
  const files = filesOf(number);
  // A small pull request arrives whole, like the host's one-piece diff.
  if (!cursor && !commit && files.length <= 100) {
    return {
      patch: patchFor(files),
      files: [],
      truncated: false,
      nextCursor: null,
      omittedFileStats: [],
    };
  }
  const page = cursor ? Number(cursor) : 1;
  const slice = (commit ? files.slice(0, 4) : files).slice((page - 1) * 100, page * 100);
  const omitted = slice
    .filter((f) => !f.hasPatch && f.additions + f.deletions > 0)
    .map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  return {
    patch: patchFor(slice),
    files: slice,
    truncated: omitted.length > 0,
    nextCursor: !commit && page * 100 < files.length ? String(page + 1) : null,
    omittedFileStats: omitted,
  };
}

const viewed = new Map<number, Map<string, PrFileViewed["state"]>>();

function filesViewed(number: number): PrFilesViewed {
  const marks = viewed.get(number) ?? new Map();
  return {
    files: filesOf(number).map((f) => ({ path: f.path, state: marks.get(f.path) ?? "unviewed" })),
    truncated: false,
  };
}

// A 1×1 PNG, so an image renders without a network.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqP9fDwAE/wH+gFJzSQAAAABJRU5ErkJggg==";

// ── handlers ────────────────────────────────────────────────────────────────

const nothing = (): null => null;

function setReaction(id: string, content: PrReactionContent, reacted: boolean): void {
  const list = [...(reactions.get(id) ?? [])];
  const at = list.findIndex((r) => r.content === content);
  const current = at >= 0 ? list[at] : { content, count: 0, actors: [], viewerHasReacted: false };
  if (current.viewerHasReacted === reacted) return;
  const next = { ...current, count: current.count + (reacted ? 1 : -1), viewerHasReacted: reacted };
  if (at >= 0) list.splice(at, 1);
  if (next.count > 0) list.push(next);
  reactions.set(id, list);
}

export interface PullRequestsResponses {
  pr_provider: PrProvider;
  pr_list: PrListResult;
  pr_detail: PrDetail;
  pr_activity: PrActivity;
  pr_thread_comments: PrThreadCommentsPage;
  pr_timeline: PrTimelinePage;
  pr_commits: PrCommitsPage;
  pr_diff: PrDiffResult;
  pr_diff_file_contents: PrDiffFileContents;
  pr_files_viewed: PrFilesViewed;
  pr_set_files_viewed: Unit;
  pr_comment: Unit;
  pr_reply_to_thread: Unit;
  pr_resolve_thread: Unit;
  pr_react: Unit;
  pr_submit_review: Unit;
  pr_action: Unit;
  pr_update: Unit;
  pr_request_reviewers: Unit;
  pr_set_labels: Unit;
  pr_image: PrImage;
}

function listMatches(entry: PrListEntry, args: MockArgs): boolean {
  const query = (args.query ?? {}) as { state?: string; search?: string; involvement?: string };
  const state = query.state ?? "open";
  if (state !== "all" && entry.state !== state) return false;
  if (query.involvement === "authored" && entry.author?.login !== VIEWER.login) return false;
  if (query.involvement === "reviewing" && !entry.viewerReviewRequested) return false;
  const text = query.search?.trim().toLowerCase();
  return !text || entry.title.toLowerCase().includes(text);
}

export const pullRequestsHandlers: TypedHandlers<PullRequestsResponses> = {
  pr_provider: () => PROVIDER,
  pr_list: (args) => ({
    provider: PROVIDER,
    entries: PULLS.map((p) => p.entry)
      .filter((e) => listMatches(e, args))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    nextCursor: null,
  }),
  pr_detail: ({ number }) => find(number).detail,
  pr_activity: ({ number }) => activity(Number(number)),
  pr_thread_comments: ({ number, threadId }) => {
    const thread = (threads.get(Number(number)) ?? []).find((t) => t.id === threadId);
    if (!thread)
      fail({ kind: "invalid", message: "That review thread belongs to another pull request." });
    return { comments: thread.id === "PRRT_412_long" ? LONG_THREAD_REST : [], nextCursor: null };
  },
  pr_timeline: ({ number, cursor }) => timeline(Number(number), (cursor as string | null) ?? null),
  pr_commits: ({ number }) => ({ commits: commitsOf(Number(number)), nextCursor: null }),
  pr_diff: ({ number, cursor, commit }) =>
    diff(Number(number), (cursor as string | null) ?? null, (commit as string | null) ?? null),
  pr_diff_file_contents: ({ changeType, newPath }) => {
    if (String(newPath).endsWith(".png"))
      fail({ kind: "unsupported", message: "This file is binary." });
    const before =
      "export function step() {\n  const state = machine.current;\n  if (state === 'failed') retry();\n  return state;\n}\n";
    const after = before.replace(
      "  if (state === 'failed') retry();\n",
      "  if (state === 'failed') {\n    machine.send({ type: 'retry' });\n  }\n",
    );
    return {
      oldContents: changeType === "new" ? "" : before,
      newContents: changeType === "deleted" ? "" : after,
    };
  },
  pr_files_viewed: ({ number }) => filesViewed(Number(number)),
  pr_set_files_viewed: ({ number, files }) => {
    const marks = viewed.get(Number(number)) ?? new Map();
    for (const f of (files ?? []) as Array<{ path: string; viewed: boolean }>) {
      marks.set(f.path, f.viewed ? "viewed" : "unviewed");
    }
    viewed.set(Number(number), marks);
    return null;
  },
  pr_comment: ({ number, body }) => {
    const list = remarks.get(Number(number)) ?? [];
    list.push({
      id: `IC_${number}_${list.length + 10}`,
      kind: "issue-comment",
      author: VIEWER,
      body: String(body),
      createdAt: new Date().toISOString(),
      editedAt: null,
      url: null,
      path: null,
      reviewState: null,
      reactions: [],
    });
    remarks.set(Number(number), list);
    return null;
  },
  pr_reply_to_thread: ({ number, threadId, body }) => {
    const thread = (threads.get(Number(number)) ?? []).find((t) => t.id === threadId);
    if (!thread) fail({ kind: "notFound" });
    thread.comments = [
      ...thread.comments,
      threadComment(`RC_reply_${thread.comments.length}`, VIEWER, String(body), 0),
    ];
    thread.commentCount += 1;
    return null;
  },
  pr_resolve_thread: ({ number, threadId, resolved }) => {
    const thread = (threads.get(Number(number)) ?? []).find((t) => t.id === threadId);
    if (!thread) fail({ kind: "notFound" });
    thread.isResolved = Boolean(resolved);
    return null;
  },
  pr_react: ({ number, subjectId, content, reacted }) => {
    setReaction(
      (subjectId as string | null) ?? `PR_${number}`,
      content as PrReactionContent,
      Boolean(reacted),
    );
    return null;
  },
  pr_submit_review: nothing,
  pr_action: ({ number, input }) => {
    const target = find(number);
    const action = (input as { action: string }).action;
    const now = new Date().toISOString();
    const set = (patch: Partial<PrDetail>) => {
      Object.assign(target.detail, patch);
      Object.assign(target.entry, {
        state: target.detail.state,
        isDraft: target.detail.isDraft,
        updatedAt: now,
      });
    };
    if (action === "merge") {
      if (target.detail.mergeability === "conflicting") {
        fail({
          kind: "failed",
          message: "Pull request is not mergeable: the merge commit cannot be cleanly created.",
        });
      }
      set({
        state: "merged",
        mergedAt: now,
        closedAt: now,
        viewerPermissions: permissions(false, false),
      });
    } else if (action === "close") set({ state: "closed", closedAt: now });
    else if (action === "reopen") set({ state: "open", closedAt: null });
    else if (action === "ready") set({ isDraft: false });
    else if (action === "draft") set({ isDraft: true });
    else if (action === "update-branch") set({ behindBy: 0, baseComparison: "up-to-date" });
    else if (action === "enable-auto-merge")
      set({ autoMergeEnabled: true, autoMergeMethod: "squash" });
    else if (action === "disable-auto-merge")
      set({ autoMergeEnabled: false, autoMergeMethod: null });
    return null;
  },
  pr_update: ({ number, title, body }) => {
    const target = find(number);
    if (typeof title === "string") target.detail.title = target.entry.title = title;
    if (typeof body === "string") target.detail.body = body;
    return null;
  },
  pr_request_reviewers: nothing,
  pr_set_labels: ({ number, labels, applied }) => {
    const target = find(number);
    const names = (labels ?? []) as string[];
    const kept = target.detail.labels.filter((l) => !names.includes(l.name));
    target.detail.labels = applied
      ? [...kept, ...names.map((name) => ({ name, color: "c5def5" }))]
      : kept;
    target.entry.labels = target.detail.labels;
    return null;
  },
  pr_image: () => ({ contentType: "image/png", data: PIXEL }),
};
