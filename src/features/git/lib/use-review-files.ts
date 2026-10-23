import { useCallback, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { getDiffFileContents, type DiffFileStat, type DiffSource } from "./git-review-api";
import { getRenderablePatch, resolveFileDiffPath } from "./diff-rendering";

/**
 * One changed file of a review source, in the order the panel lists it, with
 * whatever of it has arrived.
 *
 * The source's patch is capped near 120 KB at a file boundary, so on a large
 * change only a prefix of the files is in it. Those render from the patch at
 * once. Each one past the cap is fetched by itself (`getDiffFileContents`) and
 * diffed here — never all at once: a few up front, then each as its row
 * scrolls into the viewer's render window (`requestFile`), or when the reader
 * picks it in the tree.
 */
export interface ReviewFile {
  stat: DiffFileStat;
  /** The file's diff; an empty, partial stand-in until it is `ready`. */
  fileDiff: FileDiffMetadata;
  state: "ready" | "pending" | "error" | "binary";
  /** A side was over the backend's size cap and is cut. */
  truncated: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** How many missing files load before any row asks. */
const INITIAL_BATCH = 4;

interface Loaded {
  fileDiff: FileDiffMetadata | null;
  binary: boolean;
  truncated: boolean;
}

const isNewStatus = (s: DiffFileStat["status"]) => s === "added" || s === "untracked";

/** What a file shows before (or instead of) its diff: its header and nothing
 *  under it. */
function placeholderOf(stat: DiffFileStat): FileDiffMetadata {
  return {
    name: stat.path,
    ...(stat.oldPath ? { prevName: stat.oldPath } : {}),
    type: isNewStatus(stat.status)
      ? "new"
      : stat.status === "deleted"
        ? "deleted"
        : stat.oldPath
          ? "rename-changed"
          : "change",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
  };
}

export function useReviewFiles({
  repoPath,
  source,
  only,
}: {
  repoPath: string;
  source: DiffSource | null;
  /** Narrow to these paths (a session's files). `null`: every file. */
  only: ReadonlySet<string> | null;
}) {
  const scope = source ? `${repoPath}\0${source.kind}\0${source.diffHash}` : "";

  // Parsed once per patch: a refresh that changes nothing keeps every object,
  // so the viewer repaints nothing.
  const fromPatch = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>();
    const patch = getRenderablePatch(source?.diff, `review:${source?.diffHash ?? ""}`);
    if (patch?.kind === "files") for (const f of patch.files) map.set(resolveFileDiffPath(f), f);
    return map;
  }, [source?.diff, source?.diffHash]);

  const stats = useMemo(() => {
    const files = (source?.files ?? []).filter((f) => !only || only.has(f.path));
    return files.sort((a, b) => collator.compare(a.path, b.path));
  }, [source?.files, only]);

  // One stand-in object per file per patch, so an unchanged row keeps its
  // identity across renders.
  const placeholders = useMemo(
    () => new Map(stats.map((stat) => [stat.path, placeholderOf(stat)])),
    [stats],
  );

  /** Files not in the patch, in list order — the ones to fetch. */
  const missing = useMemo(
    () => stats.filter((f) => !f.binary && !fromPatch.has(f.path)).map((f) => f.path),
    [stats, fromPatch],
  );

  const [requested, setRequested] = useState<{ scope: string; paths: ReadonlySet<string> }>({
    scope: "",
    paths: new Set(),
  });
  const wanted = useMemo(() => {
    const paths = new Set(requested.scope === scope ? requested.paths : []);
    for (const path of missing.slice(0, INITIAL_BATCH)) paths.add(path);
    return [...paths];
  }, [requested, scope, missing]);

  const statByPath = useMemo(() => new Map(stats.map((s) => [s.path, s])), [stats]);

  const results = useQueries({
    queries: wanted.map((path) => {
      const stat = statByPath.get(path);
      return {
        // The hash is in the key, so an entry is never stale: a new patch is a
        // new key, and an unchanged one is served without asking again.
        queryKey: [
          "git-diff-file",
          repoPath,
          source?.kind,
          source?.mergeBase,
          source?.diffHash,
          path,
        ],
        enabled: !!source && !!stat,
        staleTime: Infinity,
        gcTime: 5 * 60_000,
        queryFn: async (): Promise<Loaded> => {
          const contents = await getDiffFileContents(repoPath, {
            sourceKind: source!.kind,
            baseRef: source!.mergeBase ?? source!.baseRef,
            filePath: path,
            oldPath: stat?.oldPath ?? null,
          });
          if (contents.binary) return { fileDiff: null, binary: true, truncated: false };
          const key = `review:${source!.diffHash}:${path}`;
          const fileDiff = parseDiffFromFile(
            stat && isNewStatus(stat.status)
              ? null
              : { name: stat?.oldPath ?? path, contents: contents.oldText, cacheKey: `${key}:old` },
            stat?.status === "deleted"
              ? null
              : { name: path, contents: contents.newText, cacheKey: `${key}:new` },
          );
          return { fileDiff, binary: false, truncated: contents.truncated };
        },
      };
    }),
  });

  const loadedByPath = new Map<string, (typeof results)[number]>();
  wanted.forEach((path, i) => loadedByPath.set(path, results[i]));

  const files: ReviewFile[] = stats.map((stat) => {
    const stand = placeholders.get(stat.path)!;
    if (stat.binary) return { stat, fileDiff: stand, state: "binary", truncated: false };
    const parsed = fromPatch.get(stat.path);
    if (parsed) return { stat, fileDiff: parsed, state: "ready", truncated: false };
    const result = loadedByPath.get(stat.path);
    if (result?.isError) return { stat, fileDiff: stand, state: "error", truncated: false };
    const data = result?.data;
    if (!data) return { stat, fileDiff: stand, state: "pending", truncated: false };
    if (data.binary || !data.fileDiff) {
      return { stat, fileDiff: stand, state: "binary", truncated: false };
    }
    return { stat, fileDiff: data.fileDiff, state: "ready", truncated: data.truncated };
  });

  // Stable per scope: every pending row's header holds it.
  const requestFile = useCallback(
    (path: string) =>
      setRequested((current) => {
        const prior = current.scope === scope ? current.paths : new Set<string>();
        if (prior.has(path)) return current;
        return { scope, paths: new Set([...prior, path]) };
      }),
    [scope],
  );

  const retry = (path: string) => {
    const i = wanted.indexOf(path);
    if (i >= 0) void results[i]?.refetch();
  };

  return {
    scope,
    files,
    isFetching: results.some((r) => r.isFetching),
    /** Fetch one file now: its row came into view, or the tree asked. */
    requestFile,
    retry,
  };
}
