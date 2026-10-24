// The pull-request surface tab, opened beside the session on load.
//
//  - `pull-request` — number 420: 300 comments, 100 checks and a long history
//    (label runs, review requests, a draft round trip, force-pushes, a close and
//    reopen, a dismissed review), for paging and scale;
//  - `pull-request-review` — number 412: changes requested, threads, behind its base;
//  - `pull-request-merged` — number 398; `pull-request-draft` — number 405;
//    `pull-request-conflict` — number 401, conflicting with a failing check;
//  - `pull-request-not-installed`, `-signed-out`, `-rate-limited`, `-offline`
//    — every read fails the way `gh` would, for the unavailable states.
//
// Writes are real for the page's life (see `fixtures/pull-requests.ts`).

import type { PrError } from "@/features/pull-requests/lib/pull-requests-types";
import type { Scenario } from "../types";
import { failPullRequestReads } from "../fixtures/pull-requests";
import { MOCK_PROJECT } from "../project";

function pullRequestScenario(
  name: string,
  description: string,
  number: number,
  failure: PrError | null = null,
): Scenario {
  return {
    name,
    description,
    init: () => failPullRequestReads(failure),
    setup: async () => {
      const { openPullRequestTab } =
        await import("@/features/pull-requests/lib/open-pull-request-tab");
      openPullRequestTab({ repoPath: MOCK_PROJECT.path, number });
    },
    actions: {
      /** Let reads through again, as after `gh auth login`; then press Retry. */
      recover: () => failPullRequestReads(null),
    },
  };
}

export const pullRequest = pullRequestScenario(
  "pull-request",
  "A pull request tab on a long one: 300 comments, 100 checks, a long timeline.",
  420,
);
export const pullRequestReview = pullRequestScenario(
  "pull-request-review",
  "A pull request with changes requested, review threads, and a stale base.",
  412,
);
export const pullRequestMerged = pullRequestScenario(
  "pull-request-merged",
  "A merged pull request.",
  398,
);
export const pullRequestDraft = pullRequestScenario(
  "pull-request-draft",
  "A draft pull request with no checks.",
  405,
);
export const pullRequestConflict = pullRequestScenario(
  "pull-request-conflict",
  "A pull request that conflicts with its base.",
  401,
);
export const pullRequestNotInstalled = pullRequestScenario(
  "pull-request-not-installed",
  "The pull request tab without the GitHub CLI.",
  412,
  { kind: "notInstalled" },
);
export const pullRequestSignedOut = pullRequestScenario(
  "pull-request-signed-out",
  "The pull request tab with gh signed out.",
  412,
  { kind: "notAuthenticated" },
);
export const pullRequestRateLimited = pullRequestScenario(
  "pull-request-rate-limited",
  "The pull request tab past GitHub's rate limit.",
  412,
  { kind: "rateLimited", retryAt: Date.now() + 7 * 60_000 },
);
export const pullRequestOffline = pullRequestScenario(
  "pull-request-offline",
  "The pull request tab with GitHub unreachable.",
  412,
  { kind: "network" },
);

export const pullRequestScenarios: Scenario[] = [
  pullRequest,
  pullRequestReview,
  pullRequestMerged,
  pullRequestDraft,
  pullRequestConflict,
  pullRequestNotInstalled,
  pullRequestSignedOut,
  pullRequestRateLimited,
  pullRequestOffline,
];
