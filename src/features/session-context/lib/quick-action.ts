// The one git action the overlay offers up front.
//
// Reading order: busy beats everything, then "is there a branch", then local
// changes, then upstream, then divergence, behind, ahead. What it offers is
// what Atlas can do from one click:
//
//  * Atlas's commit needs the summary the user writes, so "you have changes"
//    opens Source Control on its commit box rather than committing.
//  * There is no "Push & create PR" yet — no command opens a pull request —
//    so an unpublished branch offers "Publish branch", the push half of it.
//
// Pure, so the whole decision table is a unit test.

export interface QuickActionInput {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  /** Working-tree entries (staged or not). */
  changedFiles: number;
  /** `null` when the branch tracks nothing. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** A streaming git op (push, pull, commit hooks) is running. */
  busy: boolean;
}

export type QuickAction =
  | { kind: "push"; label: string }
  | { kind: "publish"; label: string }
  | { kind: "pull"; label: string }
  | { kind: "open-changes"; label: string }
  | { kind: "hint"; label: string; hint: string };

export function resolveQuickAction(input: QuickActionInput): QuickAction | null {
  if (!input.isRepo) return null;
  if (input.busy) return { kind: "hint", label: "Working…", hint: "A git action is in progress." };
  if (input.detached || !input.branch) {
    return {
      kind: "hint",
      label: "Push",
      hint: "Check out a branch before pushing.",
    };
  }
  if (input.changedFiles > 0) {
    return {
      kind: "open-changes",
      label: input.upstream ? "Commit & push…" : "Commit…",
    };
  }
  if (!input.upstream) {
    // A brand-new branch with nothing on it still publishes: it is how the
    // remote learns the branch exists, which is what a PR needs first.
    return { kind: "publish", label: "Publish branch" };
  }
  if (input.ahead > 0 && input.behind > 0) {
    return {
      kind: "hint",
      label: "Sync branch",
      hint: "The branch has diverged from its upstream. Rebase or merge first.",
    };
  }
  if (input.behind > 0) return { kind: "pull", label: "Pull" };
  if (input.ahead > 0) return { kind: "push", label: "Push" };
  return { kind: "hint", label: "Push", hint: "Up to date. Nothing to push." };
}
