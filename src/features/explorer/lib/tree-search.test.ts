import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "./fs-api";
import { buildSearchRows, collectMatches, isHiddenPath, normalizeTreeQuery } from "./tree-search";

const dir = (path: string, ignored?: boolean): ProjectEntry => ({
  path,
  kind: "directory",
  ...(ignored ? { ignored } : {}),
});
const file = (path: string): ProjectEntry => ({ path, kind: "file" });

const LISTINGS: ProjectEntry[][] = [
  [dir("src"), dir("node_modules", true), file(".env"), file("README.md")],
  [dir("src/lib"), file("src/main.ts")],
  [dir("node_modules/react", true)],
];

const paths = (rows: { path: string }[]) => rows.map((r) => r.path);

describe("normalizeTreeQuery", () => {
  it("trims, lower-cases and reads a backslash as a slash", () => {
    expect(normalizeTreeQuery("  Src\\Lib ")).toBe("src/lib");
    expect(normalizeTreeQuery("   ")).toBe("");
  });
});

describe("isHiddenPath", () => {
  it("is any segment starting with a dot", () => {
    expect(isHiddenPath(".env")).toBe(true);
    expect(isHiddenPath("a/.cache/b")).toBe(true);
    expect(isHiddenPath("a/b.c")).toBe(false);
  });
});

describe("collectMatches", () => {
  it("matches a substring of the whole relative path, in loaded listings and index hits", () => {
    const { hits } = collectMatches(
      LISTINGS,
      ["src/lib/deep/util.ts", "docs/guide.md"],
      "lib",
      false,
    );
    // `src/lib` and the index's file under it; `docs/guide.md` holds no "lib".
    expect([...hits.keys()].sort()).toEqual(["src/lib", "src/lib/deep/util.ts"]);
    expect(hits.get("src/lib/deep/util.ts")).toEqual({ kind: "file", ignored: false });
  });

  it("narrows the index's fuzzy answers to the same substring rule", () => {
    // A fuzzy matcher answers `mt` with `main.ts`; the tree does not.
    expect(collectMatches([], ["src/main.ts"], "mt", false).hits.size).toBe(0);
  });

  it("finds ignored entries the tree has loaded, flagged as ignored", () => {
    const { hits, ignoredDirs } = collectMatches(LISTINGS, [], "react", false);
    expect(hits.get("node_modules/react")).toEqual({ kind: "directory", ignored: true });
    expect(ignoredDirs.has("node_modules")).toBe(true);
  });

  it("skips hidden paths unless hidden files are shown", () => {
    expect(collectMatches(LISTINGS, [], "env", false).hits.has(".env")).toBe(false);
    expect(collectMatches(LISTINGS, [], "env", true).hits.has(".env")).toBe(true);
    expect(collectMatches([], [".github/ci.yml"], "ci", false).hits.size).toBe(0);
  });

  it("matches nothing for an empty query", () => {
    expect(collectMatches(LISTINGS, ["a.ts"], "", true).hits.size).toBe(0);
  });
});

describe("buildSearchRows", () => {
  it("shows each hit under its folders, all open, folders first then by name", () => {
    const { rows, matchCount, firstMatch } = buildSearchRows(
      collectMatches([], ["src/z/util.ts", "src/a.ts", "b.ts", "A.ts"], ".ts", false),
    );
    // `src` holds a folder and a file, so it is not compacted; `src/z` is.
    expect(paths(rows)).toEqual(["src", "src/z", "src/z/util.ts", "src/a.ts", "A.ts", "b.ts"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(matchCount).toBe(4);
    expect(firstMatch).toBe("src/z/util.ts");
  });

  it("compacts a folder whose only shown child is a folder, and marks hits", () => {
    const { rows } = buildSearchRows(
      collectMatches([], ["a/b/c/one.ts", "a/b/c/two.ts"], "c/", false),
    );
    expect(rows[0]).toMatchObject({ path: "a/b/c", depth: 0, chain: ["a", "a/b", "a/b/c"] });
    expect(rows[0].match).toBe(false);
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({ path: "a/b/c/one.ts", depth: 1, match: true }),
      expect.objectContaining({ path: "a/b/c/two.ts", depth: 1, match: true }),
    ]);
  });

  it("keeps a folder the user closed during the search closed", () => {
    const matches = collectMatches([], ["src/a.ts", "src/b.ts", "top.ts"], ".ts", false);
    expect(paths(buildSearchRows(matches, new Set(["src"])).rows)).toEqual(["src", "top.ts"]);
  });

  it("dims a folder above a hit when the listings know it is ignored", () => {
    const { rows } = buildSearchRows(collectMatches(LISTINGS, [], "react", false));
    expect(rows[0]).toMatchObject({
      path: "node_modules/react",
      chain: ["node_modules", "node_modules/react"],
      ignored: true,
      match: true,
    });
  });
});
