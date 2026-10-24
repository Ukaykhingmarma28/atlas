// The agent actions a pull request offers: "Fix" on a failing check or a
// finding, later "Fix findings", "Ask a question", "Explain this PR" and
// "Resolve conflicts". Each hands the work to a session.
//
// A seam for now (step 7 fills it): the hook says no action is available,
// so the Summary shows no Fix button and nothing half-works. When it lands,
// `fixFinding` opens (or reuses) a session on the pull request's checkout with
// the finding written into its composer, and `pending` names the finding in
// flight so its button reads "Preparing…".

import type { Finding } from "./pull-request-logic";

export interface PullRequestAgentActions {
  /** `null` while agent actions are unavailable; the Summary hides "Fix". */
  fixFinding: ((finding: Finding) => void) | null;
  /** `findingKey` of the finding being handed off, if any. */
  pending: string | null;
  /** The Fix button's label. */
  fixLabel: string;
}

export function usePullRequestAgentActions(_target: {
  repoPath: string;
  number: number;
}): PullRequestAgentActions {
  return { fixFinding: null, pending: null, fixLabel: "Fix" };
}
