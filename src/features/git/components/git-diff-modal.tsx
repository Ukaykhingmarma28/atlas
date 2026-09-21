// Full-screen diff modal — the side-by-side viewer, shown over the app instead
// of as a tab.
//
// Built for the agent chat's "Show changes": a turn's edits deserve the real
// diff viewer (side-by-side, word-level spans, syntax highlighting, minimap,
// changed-files tree), not the reduced unified list a 460px sidebar can hold.
// Trying to fit that viewer into the sidebar is what produced three rounds of
// horizontal-scrolling problems — there simply isn't width for two code columns
// beside a gutter.
//
// Geometry matches the Git Graph's fullscreen (`git-graph-panel.tsx`), so the
// two "expand this into the whole window" surfaces behave identically.

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
// Imported DIRECTLY, not lazily. This module is itself lazy-loaded by the chat,
// so a second `lazy()` here made opening a diff two SEQUENTIAL chunk fetches —
// the modal chunk, then the panel chunk — and no amount of prefetching the outer
// one helped, because the inner request could not start until it resolved. One
// boundary, one round trip.
import { GitDiffPanel } from "./git-diff-panel";

export function GitDiffModal({
  open,
  onOpenChange,
  repoPath,
  /** Repo-relative paths this modal is scoped to. The tree lists only these,
   *  and the FIRST one opens immediately — landing on an empty pane and asking
   *  the reader to pick makes them do work the caller already knows the answer
   *  to. */
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
  /** Before/after text per path — see `GitDiffPanel.textSources`. */
  textSources?: Record<string, { old: string; new: string }>;
  title?: string;
}) {
  const first = initialFile || files[0] || "";
  // The modal owns which file is shown. The tree cannot use its default click
  // behaviour here — that opens the standalone Git Diff module tab, which both
  // left this modal stuck on one file and dropped a workbench tab behind it.
  const [active, setActive] = useState(first);
  // Reopening on a different file (or a different turn) must retarget.
  useEffect(() => setActive(first), [first]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim data-open:animate-fade-in" />
        <Dialog.Popup
          aria-describedby={undefined}
          // Scales in from 95%. Without it the modal simply blinked into
          // existence, and an abrupt appearance reads as a slow one — there is
          // no motion to tell the eye that anything is arriving.
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
          <div className="min-h-0 flex-1">
            {/* `hidePicker`: this modal shows what a TURN changed. Browsing to
                another commit from here would silently retarget the diff to
                something the reader never asked about. */}
            <GitDiffPanel
              repoPath={repoPath}
              file={active}
              staged={false}
              hidePicker
              only={files}
              textSources={textSources}
              onSelectFile={setActive}
              // The editor tab opens BEHIND this full-screen modal — close it
              // so the jump actually lands where the user is looking.
              onOpenInEditor={() => onOpenChange(false)}
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
