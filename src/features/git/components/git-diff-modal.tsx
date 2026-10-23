// Full-screen diff modal — a turn's changes shown over the app instead of as
// a tab.
//
// Built for the agent session's "Show changes". A turn's diff is not a
// question git can answer: the working tree holds the CURRENT state, while a
// file created in turn 1, edited in turn 2 and deleted in turn 3 has three
// correct diffs and only the tool arguments know which. So each path with a
// text source is diffed from that text; one without falls back to the working
// tree against HEAD. Either way the diff is computed by the backend, so this
// thread only parses patches.
//
// Geometry matches the Git Graph's fullscreen (`git-graph-panel.tsx`), so the
// two "expand this into the whole window" surfaces behave identically.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useQueries } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { CodeViewDiffItem, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { AlertCircle, X } from "lucide-react";
import { openReviewFile } from "../lib/open-review-file";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import {
  diffTextsPatch,
  getDiffFilePatch,
  type DiffFilePatch,
  type DiffFileStat,
} from "../lib/git-review-api";
import {
  buildFileDiffContentVersion,
  getDiffLineStat,
  getRenderablePatch,
  textFingerprint,
} from "../lib/diff-rendering";
import { StyledCodeView } from "./diff-viewer/styled-code-view";
import { DiffFileTree } from "./diff-viewer/diff-file-tree";
import { CopyPathButton } from "./diff-viewer/copy-path-button";
import { DiffPanelSkeleton } from "./diff-viewer/diff-panel-skeleton";

type TextSource = { old: string; new: string };

/** `unavailable`: no text source and no repository to diff the path in. */
type FileState = "pending" | "ready" | "binary" | "too-large" | "empty" | "error" | "unavailable";

interface ModalFile {
  path: string;
  state: FileState;
  fileDiff: FileDiffMetadata;
  status: DiffFileStat["status"];
  truncated: boolean;
}

const TREE_LAYOUT_ID = "git-turn-diff-tree";

/** A text source's own change: an empty side is a file that did not exist. */
function statusOfSource(source: TextSource): DiffFileStat["status"] {
  if (source.old === "" && source.new !== "") return "added";
  if (source.new === "" && source.old !== "") return "deleted";
  return "modified";
}

function statusOfDiff(fileDiff: FileDiffMetadata | null): DiffFileStat["status"] {
  switch (fileDiff?.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

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

/** The parsed patch, named by the repo path (a text diff's headers carry only
 *  the file's name) and typed by what the source says it is. */
function fileOf(
  path: string,
  res: DiffFilePatch,
  status: DiffFileStat["status"] | null,
): { fileDiff: FileDiffMetadata | null; state: FileState } {
  if (res.binary) return { fileDiff: null, state: "binary" };
  if (!res.patch) return { fileDiff: null, state: res.truncated ? "too-large" : "empty" };
  const parsed = getRenderablePatch(res.patch, "turn-diff");
  if (parsed?.kind !== "files") throw new Error(parsed?.reason ?? "Empty patch.");
  const f = parsed.files[0];
  const type = status === "added" ? "new" : status === "deleted" ? "deleted" : f.type;
  return { fileDiff: { ...f, name: path, prevName: undefined, type }, state: "ready" };
}

export function GitDiffModal({
  open,
  onOpenChange,
  repoPath,
  /** Repo-relative paths this modal is scoped to; the tree lists only these. */
  files,
  initialFile,
  textSources,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  files: string[];
  /** Which file to land on. Falls back to the first. */
  initialFile?: string;
  /** Before/after text per path; a path without one diffs the working tree. */
  textSources?: Record<string, TextSource>;
  title?: string;
}) {
  const ignoreWhitespace = useSettingsStore((s) => s.settings.diffIgnoreWhitespace);
  // Each text source by fingerprint, hashed once per set of sources: a key
  // holding the texts themselves would keep (and compare) up to megabytes
  // per file on every render.
  const fingerprints = useMemo(() => {
    const map = new Map<string, string>();
    for (const [path, source] of Object.entries(textSources ?? {})) {
      map.set(path, `${textFingerprint(source.old)}|${textFingerprint(source.new)}`);
    }
    return map;
  }, [textSources]);
  const results = useQueries({
    queries: files.map((path) => {
      const source = textSources?.[path];
      return {
        queryKey: source
          ? ["turn-diff-text", path, fingerprints.get(path), ignoreWhitespace]
          : ["turn-diff-fallback", repoPath, path, ignoreWhitespace],
        // A path with neither a text nor a repository to diff it in has
        // nothing to load; it shows as `unavailable`, not as loading.
        enabled: open && (!!source || !!repoPath),
        staleTime: source ? Infinity : 10_000,
        gcTime: 60_000,
        queryFn: async () => {
          if (source) {
            const res = await diffTextsPatch(source.old, source.new, path, ignoreWhitespace);
            return fileOf(path, res, statusOfSource(source));
          }
          const res = await getDiffFilePatch(repoPath, {
            sourceKind: "working-tree",
            filePath: path,
            ignoreWhitespace,
          });
          return fileOf(path, res, null);
        },
      };
    }),
  });
  const resultsKey = results
    .map((r) => `${r.status}:${r.dataUpdatedAt}:${r.errorUpdatedAt}`)
    .join("|");

  const modalFiles = useMemo<ModalFile[]>(
    () =>
      files.map((path, i) => {
        const result = results[i];
        const source = textSources?.[path];
        const data = result?.data;
        const status = source ? statusOfSource(source) : statusOfDiff(data?.fileDiff ?? null);
        const state: FileState = data
          ? data.state
          : result?.isError
            ? "error"
            : !source && !repoPath
              ? "unavailable"
              : "pending";
        return {
          path,
          state,
          status,
          truncated: false,
          fileDiff: data?.fileDiff ?? placeholderOf(path, status),
        };
      }),
    // `resultsKey` stands for `results`, a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, textSources, repoPath, resultsKey],
  );
  const byPath = useMemo(() => new Map(modalFiles.map((f) => [f.path, f])), [modalFiles]);

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      modalFiles.map((file) => ({
        id: file.path,
        type: "diff" as const,
        fileDiff: file.fileDiff,
        collapsed: file.state !== "ready",
        version: buildFileDiffContentVersion(file.fileDiff) ^ file.state.length,
      })),
    [modalFiles],
  );

  const stats = useMemo<DiffFileStat[]>(
    () =>
      modalFiles.map((file) => {
        const counts = file.state === "ready" ? getDiffLineStat([file.fileDiff]) : null;
        return {
          path: file.path,
          additions: counts?.additions ?? null,
          deletions: counts?.deletions ?? null,
          status: file.status,
          binary: file.state === "binary" || undefined,
        };
      }),
    [modalFiles],
  );

  const first = initialFile || files[0] || "";
  const [selected, setSelected] = useState(first);
  useEffect(() => setSelected(first), [first]);
  const [viewer, setViewer] = useState<CodeViewHandle<undefined, undefined> | null>(null);
  const firstReady = byPath.get(first)?.state === "ready";
  // Land on the file the reader clicked, once it is in the viewer.
  useEffect(() => {
    if (viewer && firstReady) viewer.scrollTo({ type: "item", id: first, align: "start" });
  }, [viewer, first, firstReady]);

  const reveal = (path: string) => {
    setSelected(path);
    viewer?.scrollTo({ type: "item", id: path, align: "start" });
  };

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: TREE_LAYOUT_ID });
  const anyPending = modalFiles.some((f) => f.state === "pending");
  const allSettledEmpty = !anyPending && modalFiles.every((f) => f.state !== "ready");

  const viewerArea =
    files.length === 0 ? (
      <Empty>No files to show.</Empty>
    ) : modalFiles.every((f) => f.state === "pending") ? (
      <DiffPanelSkeleton />
    ) : (
      <StyledCodeView
        viewerRef={setViewer}
        className="h-full min-h-0 overflow-auto"
        items={items}
        fallback={<DiffPanelSkeleton />}
        options={{ diffStyle: "split", overflow: "scroll", stickyHeaders: true }}
        renderHeaderFilenameSuffix={(item) => {
          const file = byPath.get(item.id);
          return (
            <span className="ml-1 inline-flex items-center gap-1">
              <CopyPathButton path={item.id} />
              {file && (
                <FileNote
                  state={file.state}
                  onRetry={() => void results[files.indexOf(file.path)]?.refetch()}
                />
              )}
            </span>
          );
        }}
      />
    );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim data-open:animate-fade-in" />
        <Dialog.Popup
          aria-describedby={undefined}
          // Scales in from 95%: an abrupt appearance reads as a slow one.
          className="fixed top-8.5 left-4 right-4 bottom-6 z-modal flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--sidebar)] shadow-md focus:outline-none data-open:animate-scale-in"
        >
          <Dialog.Title className="sr-only">{title ?? "Changes"}</Dialog.Title>
          <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
            <span className="truncate text-xs font-medium text-[var(--secondary-foreground)]">
              {title ?? "Changes"}
            </span>
            {allSettledEmpty && files.length > 0 && (
              <span className="text-2xs text-muted-foreground">
                Nothing here can be shown as text.
              </span>
            )}
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <Group
            id={TREE_LAYOUT_ID}
            orientation="horizontal"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
            className="min-h-0 flex-1"
          >
            <Panel id="turn-diff-files" className="min-w-0">
              <div
                className="h-full min-h-0 min-w-0"
                onClickCapture={(event) => {
                  const path = event.nativeEvent.composedPath();
                  const titleEl = path.find(
                    (n): n is HTMLElement =>
                      n instanceof HTMLElement && n.hasAttribute("data-title"),
                  );
                  const name = titleEl?.textContent?.trim();
                  if (!name || !repoPath) return;
                  // The editor tab opens BEHIND this modal — close it so the
                  // jump lands where the reader is looking.
                  void openReviewFile(`${repoPath}/${name}`);
                  onOpenChange(false);
                }}
              >
                {viewerArea}
              </div>
            </Panel>
            {files.length > 1 && (
              <>
                <Separator className="w-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary cursor-col-resize" />
                <Panel
                  id="turn-diff-tree"
                  defaultSize="20"
                  minSize="12"
                  maxSize="45"
                  className="flex min-w-0 flex-col"
                >
                  <DiffFileTree files={stats} selectedPath={selected} onSelect={reveal} />
                </Panel>
              </>
            )}
          </Group>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Why a file's header has nothing under it. */
function FileNote({ state, onRetry }: { state: FileState; onRetry: () => void }) {
  switch (state) {
    case "pending":
      return <span className="text-2xs text-muted-foreground">Loading…</span>;
    case "binary":
      return <span className="text-2xs text-muted-foreground">Binary</span>;
    case "too-large":
      return <span className="text-2xs text-muted-foreground">Too large to show</span>;
    case "empty":
      return <span className="text-2xs text-muted-foreground">No changes</span>;
    case "unavailable":
      return <span className="text-2xs text-muted-foreground">Not available</span>;
    case "error":
      return (
        <Hint label="Couldn't load this file. Retry">
          <IconButton
            size="xs"
            icon={AlertCircle}
            label="Retry loading diff"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          />
        </Hint>
      );
    default:
      return null;
  }
}
