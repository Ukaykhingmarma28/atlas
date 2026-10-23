// Full-screen diff modal — a turn's changes shown over the app instead of as
// a tab.
//
// Built for the agent chat's "Show changes". A turn's diff is not a question
// git can answer: the working tree holds the CURRENT state, while a file
// created in turn 1, edited in turn 2 and deleted in turn 3 has three correct
// diffs and only the tool arguments know which. So each path with a text
// source is diffed from that text; one without falls back to the working tree
// against HEAD.
//
// Geometry matches the Git Graph's fullscreen (`git-graph-panel.tsx`), so the
// two "expand this into the whole window" surfaces behave identically.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useQueries } from "@tanstack/react-query";
import { parseDiffFromFile, type CodeViewDiffItem, type FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { X } from "lucide-react";
import { openFile } from "@/lib/open-file";
import { getDiffFileContents, type DiffFileStat } from "../lib/git-review-api";
import { buildFileDiffContentVersion, getDiffLineStat } from "../lib/diff-rendering";
import { StyledCodeView } from "./diff-viewer/styled-code-view";
import { DiffFileTree } from "./diff-viewer/diff-file-tree";
import { CopyPathButton } from "./diff-viewer/copy-path-button";
import { DiffPanelSkeleton } from "./diff-viewer/diff-panel-skeleton";

type TextSource = { old: string; new: string };

function diffOf(path: string, source: TextSource): FileDiffMetadata {
  return parseDiffFromFile(source.old === "" ? null : { name: path, contents: source.old }, {
    name: path,
    contents: source.new,
  });
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
  const fallbacks = files.filter((f) => !textSources?.[f]);
  const loaded = useQueries({
    queries: fallbacks.map((path) => ({
      queryKey: ["turn-diff-fallback", repoPath, path],
      enabled: open && !!repoPath,
      staleTime: 10_000,
      queryFn: () => getDiffFileContents(repoPath, { sourceKind: "working-tree", filePath: path }),
    })),
  });
  const loadedKey = loaded.map((q) => q.dataUpdatedAt).join(",");

  // Diffing two texts is linear work on this thread; tokenizing is not, and
  // stays in the viewer's workers.
  const diffs = useMemo(() => {
    const out = new Map<string, FileDiffMetadata>();
    for (const path of files) {
      const source = textSources?.[path];
      if (source) {
        out.set(path, diffOf(path, source));
        continue;
      }
      const data = loaded[fallbacks.indexOf(path)]?.data;
      if (data && !data.binary)
        out.set(path, diffOf(path, { old: data.oldText, new: data.newText }));
    }
    return out;
    // `loadedKey` stands for `loaded`, a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, textSources, loadedKey]);

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      files.flatMap((path) => {
        const fileDiff = diffs.get(path);
        return fileDiff
          ? [
              {
                id: path,
                type: "diff" as const,
                fileDiff,
                version: buildFileDiffContentVersion(fileDiff),
              },
            ]
          : [];
      }),
    [files, diffs],
  );

  const stats = useMemo<DiffFileStat[]>(
    () =>
      files.map((path) => {
        const fileDiff = diffs.get(path);
        const stat = fileDiff ? getDiffLineStat([fileDiff]) : null;
        return {
          path,
          additions: stat?.additions ?? null,
          deletions: stat?.deletions ?? null,
          status: fileDiff?.type === "new" ? "added" : "modified",
        };
      }),
    [files, diffs],
  );

  const first = initialFile || files[0] || "";
  const [selected, setSelected] = useState(first);
  useEffect(() => setSelected(first), [first]);
  const [viewer, setViewer] = useState<CodeViewHandle<undefined, undefined> | null>(null);
  const firstReady = diffs.has(first);
  // Land on the file the reader clicked, once it is in the viewer.
  useEffect(() => {
    if (viewer && firstReady) viewer.scrollTo({ type: "item", id: first, align: "start" });
  }, [viewer, first, firstReady]);

  const reveal = (path: string) => {
    setSelected(path);
    viewer?.scrollTo({ type: "item", id: path, align: "start" });
  };

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
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <div
              className="min-h-0 min-w-0 flex-1"
              onClickCapture={(event) => {
                const path = event.nativeEvent.composedPath();
                const title = path.find(
                  (n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute("data-title"),
                );
                const name = title?.textContent?.trim();
                if (!name || !repoPath) return;
                // The editor tab opens BEHIND this modal — close it so the jump
                // lands where the reader is looking.
                void openFile(`${repoPath}/${name}`);
                onOpenChange(false);
              }}
            >
              {items.length === 0 ? (
                <DiffPanelSkeleton />
              ) : (
                <StyledCodeView
                  viewerRef={setViewer}
                  className="h-full min-h-0 overflow-auto"
                  items={items}
                  fallback={<DiffPanelSkeleton />}
                  options={{ diffStyle: "split", overflow: "scroll", stickyHeaders: true }}
                  renderHeaderFilenameSuffix={(item) => <CopyPathButton path={item.id} />}
                />
              )}
            </div>
            {files.length > 1 && (
              <aside className="flex w-56 shrink-0 flex-col border-l border-border">
                <DiffFileTree files={stats} selectedPath={selected} onSelect={reveal} />
              </aside>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
