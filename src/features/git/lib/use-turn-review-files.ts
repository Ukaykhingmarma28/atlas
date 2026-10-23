// The review panel's turn scope: one agent turn's own edits, diffed from the
// before/after text its tool calls carried — never from git.
//
// Git cannot answer "what did turn 2 change": it holds the CURRENT tree, so a
// file created in turn 1, edited in turn 2 and deleted in turn 3 has one git
// answer and three correct turn diffs, and once the edits are committed git
// reports nothing at all. The turn's text pairs come from the session's
// message log (`collectTurnEdits`); the backend diffs each pair
// (`diff_texts_patch`) and this thread only parses the patch.
//
// Everything here is keyed so a settled turn costs nothing per render: the
// session is watched through `editsSignature` (a string that ignores streamed
// prose), each text pair keeps its object while its text is unchanged, and
// each file's query is keyed by its texts' fingerprints, never the texts.

import { useCallback, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { ChatMessage } from "@/types/agent";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  collectTurnEdits,
  editsSignature,
  listEditTurns,
  type EditTurn,
  type TurnEdit,
  type TurnEdits,
} from "@/features/chat/lib/turn-edits";
import { diffTextsPatch, type DiffFilePatch, type DiffFileStat } from "./git-review-api";
import { getDiffLineStat, getRenderablePatch, textFingerprint } from "./diff-rendering";
import type { ReviewFile } from "./use-review-files";
import { countChangedLines } from "@/features/chat/lib/tool-files";

type ChatState = ReturnType<typeof useChatStore.getState>;

/** The message log of the chat whose agent session is `sessionId`. */
export function sessionMessages(
  state: ChatState,
  sessionId: string | null,
): ChatMessage[] | undefined {
  if (!sessionId) return undefined;
  for (const session of Object.values(state.sessions)) {
    if (session.acpSessionId === sessionId) return session.messages;
  }
  return undefined;
}

/** Re-renders only when the session's edits may have changed. */
function useEditsSignature(sessionId: string | null): string {
  return useChatStore((s) => editsSignature(sessionMessages(s, sessionId)));
}

/** The session's turns that changed files, newest first. */
export function useSessionEditTurns(sessionId: string | null, repoPath: string): EditTurn[] {
  const signature = useEditsSignature(sessionId);
  return useMemo(
    () => listEditTurns(sessionMessages(useChatStore.getState(), sessionId) ?? [], repoPath),
    // `signature` stands for the messages, read here through `getState`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, sessionId, repoPath],
  );
}

/**
 * One turn's text pairs. A pair whose texts did not change keeps its object,
 * so the query keyed on it, and the viewer item built from it, see nothing new.
 */
export function useTurnEdits(
  sessionId: string | null,
  turnId: string | null,
  repoPath: string,
): TurnEdits | null {
  const signature = useEditsSignature(turnId ? sessionId : null);
  const previous = useRef<Record<string, TurnEdit>>({});
  return useMemo(() => {
    if (!turnId) return null;
    const messages = sessionMessages(useChatStore.getState(), sessionId) ?? [];
    const edits = collectTurnEdits(messages, turnId, repoPath);
    const sources: Record<string, TurnEdit> = {};
    for (const path of edits.files) {
      const next = edits.sources[path];
      const prior = previous.current[path];
      sources[path] = prior && prior.old === next.old && prior.new === next.new ? prior : next;
    }
    previous.current = sources;
    return { ...edits, sources };
    // `signature` stands for the messages, read here through `getState`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, sessionId, turnId, repoPath]);
}

/** A text pair's own change: an empty side is a file that did not exist. */
export function statusOfSource(source: TurnEdit): DiffFileStat["status"] {
  if (source.old === "" && source.new !== "") return "added";
  if (source.new === "" && source.old !== "") return "deleted";
  return "modified";
}

/** What a file shows until its patch is parsed: its header, nothing under it. */
function placeholderOf(path: string, status: DiffFileStat["status"]): FileDiffMetadata {
  return {
    name: path,
    type: status === "added" ? "new" : status === "deleted" ? "deleted" : "change",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
  };
}

interface Loaded {
  fileDiff: FileDiffMetadata | null;
  state: "ready" | "binary" | "too-large" | "empty";
}

/** The parsed patch, named by the repo path (a text diff's headers carry only
 *  the file's name) and typed by what the pair says it is. */
export function loadedOf(path: string, res: DiffFilePatch, status: DiffFileStat["status"]): Loaded {
  if (res.binary) return { fileDiff: null, state: "binary" };
  if (!res.patch) return { fileDiff: null, state: res.truncated ? "too-large" : "empty" };
  const parsed = getRenderablePatch(res.patch, "turn-diff");
  if (parsed?.kind !== "files") throw new Error(parsed?.reason ?? "Empty patch.");
  const f = parsed.files[0];
  const type = status === "added" ? "new" : status === "deleted" ? "deleted" : f.type;
  return { fileDiff: { ...f, name: path, prevName: undefined, type }, state: "ready" };
}

/** Each pair's fingerprint, hashed once per pair object: a key holding the
 *  texts would keep (and compare) up to megabytes per file on every render. */
const fingerprints = new WeakMap<TurnEdit, string>();
function fingerprintOf(source: TurnEdit): string {
  let fp = fingerprints.get(source);
  if (fp === undefined) {
    fp = `${textFingerprint(source.old)}|${textFingerprint(source.new)}`;
    fingerprints.set(source, fp);
  }
  return fp;
}

/**
 * The turn's files in the shape the review panel renders, like
 * `useReviewFiles` for a git source. Every file is asked for at once: a turn
 * is the agent's own edits, a handful of files, not a branch's thousands.
 */
export function useTurnReviewFiles({
  edits,
  ignoreWhitespace,
}: {
  edits: TurnEdits | null;
  ignoreWhitespace: boolean;
}) {
  const paths = useMemo(() => edits?.files ?? [], [edits]);
  const results = useQueries({
    queries: paths.map((path) => {
      const source = edits!.sources[path];
      return {
        queryKey: ["turn-diff-text", path, fingerprintOf(source), ignoreWhitespace],
        staleTime: Infinity,
        gcTime: 60_000,
        queryFn: async () => {
          const res = await diffTextsPatch(source.old, source.new, path, ignoreWhitespace);
          return loadedOf(path, res, statusOfSource(source));
        },
      };
    }),
  });
  // `results` is a new array every render; this changes only when one of
  // them does, which is what `files` follows.
  const resultsKey = results
    .map((r) => `${r.status}:${r.dataUpdatedAt}:${r.errorUpdatedAt}`)
    .join("|");

  // One stand-in per file and pair, so an unchanged row keeps its identity.
  const placeholders = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>();
    for (const path of paths)
      map.set(path, placeholderOf(path, statusOfSource(edits!.sources[path])));
    return map;
  }, [paths, edits]);

  const files = useMemo<ReviewFile[]>(
    () =>
      paths.map((path, i): ReviewFile => {
        const source = edits!.sources[path];
        const result = results[i];
        const data = result?.data;
        const status = statusOfSource(source);
        const ready = data?.state === "ready" && data.fileDiff;
        // The patch's own counts once it is parsed; until then, the pair's.
        const counts = ready ? getDiffLineStat([data.fileDiff!]) : null;
        const guess = counts ? null : countChangedLines(source.old, source.new);
        return {
          stat: {
            path,
            status,
            additions: counts ? counts.additions : guess!.added,
            deletions: counts ? counts.deletions : guess!.removed,
          },
          fileDiff: data?.fileDiff ?? placeholders.get(path)!,
          state: data ? data.state : result?.isError ? "error" : "pending",
          truncated: false,
          excerpt: edits!.excerpts.has(path),
        };
      }),
    // `resultsKey` stands for `results`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paths, edits, placeholders, resultsKey],
  );

  const stats = useMemo(() => files.map((f) => f.stat), [files]);

  const resultsRef = useRef(results);
  resultsRef.current = results;
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const retry = useCallback((path: string) => {
    const i = pathsRef.current.indexOf(path);
    if (i >= 0) void resultsRef.current[i]?.refetch();
  }, []);
  // Every file is already asked for.
  const requestFile = useCallback((_path: string) => {}, []);

  return { files, stats: stats as readonly DiffFileStat[], requestFile, retry };
}
