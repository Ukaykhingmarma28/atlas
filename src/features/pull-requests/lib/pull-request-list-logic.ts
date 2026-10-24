/**
 * The pull-request list, as data: which group a row falls in, what the
 * filters and the search keep, the order a sort puts each group in, and the
 * authors and labels the filter menu offers. Pure, for the test.
 *
 * One repository at a time: the viewer is the provider's (`PrProvider.viewer`),
 * so "authored" means authored by whoever `gh` is signed in as.
 */

import type {
  PrActor,
  PrChecksState,
  PrListEntry,
  PrListState,
  PrReviewDecision,
} from "./pull-requests-types";

export type PullRequestGroupKey = "authored" | "reviewRequested" | "others";

export interface PullRequestGroup {
  key: PullRequestGroupKey;
  label: string;
  entries: PrListEntry[];
}

const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  authored: "Authored",
  reviewRequested: "Review requested",
  others: "Others",
};

export type PullRequestListSort =
  | "ready"
  | "blocked"
  | "updated"
  | "newest"
  | "oldest"
  | "largest"
  | "smallest";

/** What the list narrows to on this side of the wire. */
export interface PullRequestLocalFilters {
  draft?: "only" | "hide";
  review?: PrReviewDecision | "none";
  checks?: Extract<PrChecksState, "passing" | "failing">;
  author?: string;
  labels?: string[];
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

const authoredBy = (entry: PrListEntry, viewer: string | null) => {
  const who = normalize(viewer);
  return who !== null && normalize(entry.author?.login) === who;
};

/** Authored by the viewer, then review requested of them, then the rest.
 *  Empty groups are left out; each keeps the order it came in. */
export function groupPullRequestsByInvolvement(
  entries: readonly PrListEntry[],
  viewer: string | null,
): PullRequestGroup[] {
  const buckets: Record<PullRequestGroupKey, PrListEntry[]> = {
    authored: [],
    reviewRequested: [],
    others: [],
  };
  for (const entry of entries) {
    if (authoredBy(entry, viewer)) buckets.authored.push(entry);
    else if (entry.viewerReviewRequested) buckets.reviewRequested.push(entry);
    else buckets.others.push(entry);
  }
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

/** `@me` as an author filter means the viewer. */
function resolveAuthor(author: string, viewer: string | null): string {
  return author.trim().toLowerCase() === "@me" && viewer ? viewer : author;
}

export function matchesPullRequestFilters(
  entry: PrListEntry,
  filters: PullRequestLocalFilters,
  viewer: string | null,
): boolean {
  const labels = entry.labels.map((label) => label.name.trim().toLowerCase());
  return (
    (filters.draft === undefined || entry.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? entry.reviewDecision === null
        : entry.reviewDecision === filters.review)) &&
    (filters.checks === undefined || entry.checksState === filters.checks) &&
    (filters.labels === undefined ||
      filters.labels.every((label) => labels.includes(label.trim().toLowerCase()))) &&
    (filters.author === undefined ||
      normalize(entry.author?.login) === normalize(resolveAuthor(filters.author, viewer)))
  );
}

export function hasLocalFilters(filters: PullRequestLocalFilters): boolean {
  return Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  );
}

/** Whether the row itself shows `query`: number, title, branch or author. */
export function matchesPullRequestQuery(entry: PrListEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `#${entry.number} ${entry.title} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(needle);
}

/**
 * How well a row answers `query`. The host searches more than a row shows
 * (bodies, commit messages), so a real match can score the floor — the row
 * says "matched in the description" for it.
 */
export function scorePullRequestMatch(entry: PrListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const number = needle.replace(/^#/u, "");
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;
  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter(Boolean);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (terms.some((term) => title.includes(term))) return 30;
  return 10;
}

/** The score at or below which a match is somewhere the row does not show. */
export const MATCHED_ELSEWHERE_SCORE = 10;

export function rankPullRequestMatches(
  entries: readonly PrListEntry[],
  query: string,
): PrListEntry[] {
  if (!query.trim()) return [...entries];
  return [...entries].sort(
    (a, b) =>
      scorePullRequestMatch(b, query) - scorePullRequestMatch(a, query) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

const size = (entry: PrListEntry) => entry.additions + entry.deletions;
const measured = (entry: PrListEntry) => size(entry) > 0;

/** Ready to merge first (green and approved, then green), then waiting,
 *  drafts, closed, and conflicting last; smaller first within a tier. */
export function rankPullRequestsByMergeReadiness(entries: readonly PrListEntry[]): PrListEntry[] {
  const tier = (entry: PrListEntry) => {
    if (entry.mergeability === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.isDraft) return 2;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 0;
    if (entry.checksState === "passing") return 1;
    return 2;
  };
  return [...entries].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      Number(measured(b)) - Number(measured(a)) ||
      size(a) - size(b) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

function rankByTierThenRecency(
  entries: readonly PrListEntry[],
  tier: (entry: PrListEntry) => number,
): PrListEntry[] {
  return [...entries].sort((a, b) => tier(a) - tier(b) || b.updatedAt.localeCompare(a.updatedAt));
}

/** What waits on the author: conflicts, changes asked for, failing checks,
 *  drafts; finished ones last. */
export function rankPullRequestsBlockedOnAuthor(entries: readonly PrListEntry[]): PrListEntry[] {
  return rankByTierThenRecency(entries, (entry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeability === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checksState === "failing") return 2;
    if (entry.isDraft) return 3;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 5;
    return 4;
  });
}

function rankPullRequestsBlockedOnReviewer(entries: readonly PrListEntry[]): PrListEntry[] {
  return rankByTierThenRecency(entries, (entry) => (entry.state === "open" ? 0 : 1));
}

/** Each group in `sort`'s order. A search keeps the host's relevance order
 *  for the readiness and blocked sorts, which are about triage, not finding. */
export function sortPullRequestGroups(
  groups: readonly PullRequestGroup[],
  sort: PullRequestListSort,
  searchText: string,
): PullRequestGroup[] {
  const within = (rank: (entries: readonly PrListEntry[]) => PrListEntry[]) =>
    groups.map((group) => ({ ...group, entries: rank(group.entries) }));
  const searching = searchText.trim().length > 0;
  if (sort === "ready") return searching ? [...groups] : within(rankPullRequestsByMergeReadiness);
  if (sort === "blocked") {
    if (searching) return [...groups];
    return groups.map((group) =>
      group.key === "authored"
        ? { ...group, entries: rankPullRequestsBlockedOnAuthor(group.entries) }
        : group.key === "reviewRequested"
          ? { ...group, entries: rankPullRequestsBlockedOnReviewer(group.entries) }
          : group,
    );
  }
  if (sort === "updated") {
    return within((entries) => [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  return within((entries) =>
    [...entries].sort((a, b) => {
      if (sort === "newest" || sort === "oldest") {
        const dated = a.createdAt.localeCompare(b.createdAt);
        return (sort === "newest" ? -dated : dated) || b.updatedAt.localeCompare(a.updatedAt);
      }
      const sized = size(a) - size(b);
      return (
        Number(measured(b)) - Number(measured(a)) ||
        (sort === "largest" ? -sized : sized) ||
        b.updatedAt.localeCompare(a.updatedAt)
      );
    }),
  );
}

export interface PullRequestAuthorFacet {
  actor: PrActor;
  count: number;
  mergedCount: number;
}

export interface PullRequestLabelFacet {
  name: string;
  color: string | null;
  count: number;
}

/** The authors (most merges first) and labels (most used first) among the
 *  loaded rows, for the filter menu. Rows outside `state` count toward an
 *  author's merges only. */
export function collectPullRequestListFacets(
  entries: readonly PrListEntry[],
  state: PrListState,
): { authors: PullRequestAuthorFacet[]; labels: PullRequestLabelFacet[] } {
  const authors = new Map<string, PullRequestAuthorFacet>();
  const labels = new Map<string, PullRequestLabelFacet>();
  const unique = new Map(entries.map((entry) => [entry.number, entry]));
  for (const entry of unique.values()) {
    const inState = state === "all" || entry.state === state;
    const login = normalize(entry.author?.login);
    if (entry.author && login) {
      const held = authors.get(login);
      authors.set(login, {
        actor: held?.actor ?? entry.author,
        count: (held?.count ?? 0) + Number(inState),
        mergedCount: (held?.mergedCount ?? 0) + Number(entry.state === "merged"),
      });
    }
    if (!inState) continue;
    for (const label of entry.labels) {
      const key = normalize(label.name);
      if (!key) continue;
      const held = labels.get(key);
      labels.set(key, {
        name: held?.name ?? label.name,
        color: held?.color ?? label.color,
        count: (held?.count ?? 0) + 1,
      });
    }
  }
  return {
    authors: [...authors.values()]
      .filter((author) => author.count > 0)
      .sort(
        (a, b) =>
          b.mergedCount - a.mergedCount ||
          b.count - a.count ||
          a.actor.login.localeCompare(b.actor.login),
      ),
    labels: [...labels.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
