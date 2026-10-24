import { describe, expect, it } from "vitest";

import {
  collectPullRequestListFacets,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  rankPullRequestsByMergeReadiness,
  scorePullRequestMatch,
  sortPullRequestGroups,
} from "./pull-request-list-logic";
import {
  DEFAULT_PULL_REQUEST_LIST_PREFERENCES,
  decodePullRequestListPreferences,
  readPullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pull-request-list-preferences";
import type { PrListEntry } from "./pull-requests-types";

function entry(number: number, over: Partial<PrListEntry> = {}): PrListEntry {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    author: { login: "someone", name: null, avatarUrl: null, isBot: false },
    headBranch: `branch-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 10,
    deletions: 2,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    reviewDecision: null,
    checksState: null,
    commentCount: 0,
    ...over,
  };
}

const me = { login: "Uzayer", name: null, avatarUrl: null, isBot: false };

describe("groupPullRequestsByInvolvement", () => {
  it("puts the viewer's own first, then review requests, then the rest", () => {
    const groups = groupPullRequestsByInvolvement(
      [entry(1), entry(2, { viewerReviewRequested: true }), entry(3, { author: me })],
      "uzayer",
    );
    expect(groups.map((g) => [g.key, g.entries.map((e) => e.number)])).toEqual([
      ["authored", [3]],
      ["reviewRequested", [2]],
      ["others", [1]],
    ]);
  });
  it("puts everything under Others with no viewer", () => {
    expect(groupPullRequestsByInvolvement([entry(1, { author: me })], null)[0]!.key).toBe("others");
  });
});

describe("filters and search", () => {
  it("narrows by draft, review, checks, author and labels", () => {
    const pr = entry(1, {
      isDraft: true,
      reviewDecision: "approved",
      checksState: "passing",
      author: me,
      labels: [{ name: "Bug", color: null }],
    });
    expect(matchesPullRequestFilters(pr, { draft: "only" }, null)).toBe(true);
    expect(matchesPullRequestFilters(pr, { draft: "hide" }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { review: "none" }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { checks: "failing" }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { author: "@me" }, "uzayer")).toBe(true);
    expect(matchesPullRequestFilters(pr, { labels: ["bug"] }, null)).toBe(true);
    expect(matchesPullRequestFilters(pr, { labels: ["bug", "ui"] }, null)).toBe(false);
  });
  it("matches what the row shows, and scores a number exactly", () => {
    const pr = entry(42, { title: "Add discount codes", headBranch: "feature/discounts" });
    expect(matchesPullRequestQuery(pr, "#42")).toBe(true);
    expect(matchesPullRequestQuery(pr, "discounts")).toBe(true);
    expect(scorePullRequestMatch(pr, "42")).toBe(100);
    expect(scorePullRequestMatch(pr, "4")).toBe(0);
    expect(scorePullRequestMatch(pr, "add discount codes")).toBe(90);
    expect(scorePullRequestMatch(pr, "nowhere")).toBe(10);
  });
});

describe("sorting", () => {
  it("ranks ready to merge first and conflicts last", () => {
    const ranked = rankPullRequestsByMergeReadiness([
      entry(1, { mergeability: "conflicting" }),
      entry(2, { checksState: "passing", reviewDecision: "approved" }),
      entry(3, { isDraft: true }),
      entry(4, { checksState: "passing" }),
    ]);
    expect(ranked.map((e) => e.number)).toEqual([2, 4, 3, 1]);
  });
  it("sorts within each group and keeps relevance order while searching", () => {
    const groups = [
      {
        key: "others" as const,
        label: "Others",
        entries: [
          entry(1, { createdAt: "2026-09-01T00:00:00Z", additions: 500 }),
          entry(2, { createdAt: "2026-10-05T00:00:00Z", additions: 1 }),
        ],
      },
    ];
    const order = (sort: Parameters<typeof sortPullRequestGroups>[1], q = "") =>
      sortPullRequestGroups(groups, sort, q)[0]!.entries.map((e) => e.number);
    expect(order("newest")).toEqual([2, 1]);
    expect(order("oldest")).toEqual([1, 2]);
    expect(order("largest")).toEqual([1, 2]);
    expect(order("smallest")).toEqual([2, 1]);
    expect(order("ready", "change")).toEqual([1, 2]);
  });
});

describe("facets", () => {
  it("counts authors by merges and labels by use", () => {
    const facets = collectPullRequestListFacets(
      [
        entry(1, { author: me, state: "merged" }),
        entry(2, { author: me, labels: [{ name: "ui", color: "ff0000" }] }),
        entry(3, {
          labels: [
            { name: "UI", color: null },
            { name: "bug", color: null },
          ],
        }),
      ],
      "open",
    );
    expect(facets.authors.map((a) => [a.actor.login, a.count, a.mergedCount])).toEqual([
      ["Uzayer", 1, 1],
      ["someone", 1, 0],
    ]);
    expect(facets.labels.map((l) => [l.name, l.count])).toEqual([
      ["ui", 2],
      ["bug", 1],
    ]);
  });
});

describe("preferences", () => {
  it("keeps what is valid and drops the rest", () => {
    const prefs = decodePullRequestListPreferences({
      state: "merged",
      involvement: "bogus",
      sort: "largest",
      filters: { draft: "hide", review: "maybe", labels: ["bug", 3] },
    });
    expect(prefs).toEqual({
      state: "merged",
      involvement: "all",
      sort: "largest",
      filters: { draft: "hide", labels: ["bug"] },
    });
  });
  it("round-trips through storage, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const prefs = { ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, state: "all" as const };
    writePullRequestListPreferences(prefs, storage);
    expect(readPullRequestListPreferences(storage)).toEqual(prefs);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writePullRequestListPreferences(prefs, broken)).not.toThrow();
    expect(readPullRequestListPreferences(broken)).toEqual(DEFAULT_PULL_REQUEST_LIST_PREFERENCES);
  });
});
