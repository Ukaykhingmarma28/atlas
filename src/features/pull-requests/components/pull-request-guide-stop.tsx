// One stop of the review guide, and the rail that lists them: the stop's
// title and summary, the call it asks the reader to make, its excerpts cut
// from the pull request's diff, its lettered notes, the other files it owns,
// and the questions it suggests asking.

import type { FileDiffMetadata } from "@pierre/diffs";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  File as FileIcon,
  MessageCircleQuestion,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Kbd } from "@/ui/kbd";
import { StyledFileDiff } from "@/features/git/components/diff-viewer/styled-code-view";
import { getRenderablePatch, resolveFileDiffPreviousPath } from "@/features/git/lib/diff-rendering";

import {
  excerptRows,
  fileDiffRows,
  letterStopNotes,
  rowsToPatch,
  stopSubline,
  type ExcerptNoteMarker,
} from "../lib/pull-request-guide-tour";
import type {
  GuideAttentionKind,
  GuideExcerpt as GuideExcerptData,
  GuideNote,
  GuideStop as GuideStopData,
} from "../lib/pull-request-guide-types";
import { PullRequestMarkdown } from "./pull-request-markdown";

const ATTENTION_LABELS: Record<GuideAttentionKind, string> = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
};

function GuideProse({ text, plain = false }: { text: string; plain?: boolean }) {
  if (plain) return <>{text}</>;
  return <PullRequestMarkdown text={text} />;
}

// ── rail ────────────────────────────────────────────────────────────────

export function GuideRail({
  stops,
  position,
  seen,
  onSelect,
}: {
  stops: readonly GuideStopData[];
  position: number;
  seen: ReadonlySet<number>;
  onSelect: (position: number) => void;
}) {
  return (
    <nav aria-label="Review tour" className="flex min-h-0 flex-col gap-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {seen.size} of {stops.length} read
      </p>
      <ol className="flex flex-col gap-0.5">
        {stops.map((stop, index) => (
          <li key={index}>
            <button
              type="button"
              aria-current={position === index ? "step" : undefined}
              onClick={() => onSelect(index)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                position === index ? "bg-element-selected" : "hover:bg-element-hover",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs tabular-nums",
                  seen.has(index)
                    ? "border-success text-success"
                    : "border-border text-muted-foreground",
                )}
              >
                {seen.has(index) ? (
                  <Check aria-label={`Stop ${index + 1}, read`} className="size-3" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{stop.title}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {stop.attention !== null ? (
                    <Badge size="sm" variant="warning">
                      Look closely
                    </Badge>
                  ) : null}
                  <span>{stopSubline(stop)}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ── notes ───────────────────────────────────────────────────────────────

function NoteMarker({ marker }: { marker: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-info-muted text-3xs font-medium text-info tabular-nums"
    >
      {marker}
    </span>
  );
}

function GuideNotes({
  notes,
  className,
}: {
  notes: readonly { marker: string; note: GuideNote }[];
  className?: string;
}) {
  if (notes.length === 0) return null;
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h4 className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground">
        Notes on this stop
        <span className="font-normal text-muted-foreground tabular-nums">
          {notes.length === 1 ? "1 note" : `${notes.length} notes`}
        </span>
      </h4>
      <ol className="flex flex-col gap-3">
        {notes.map(({ marker, note }) => (
          <li key={marker} className="flex min-w-0 gap-2">
            <NoteMarker marker={marker} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium text-foreground">{note.title}</span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {note.path.split("/").pop()}:{note.line}
                </span>
              </p>
              {note.body.trim() !== "" ? (
                <div className="text-xs text-muted-foreground">
                  <GuideProse text={note.body} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── excerpts ────────────────────────────────────────────────────────────

interface ExcerptAnnotation {
  markers: ExcerptNoteMarker["markers"];
}

function excerptSlice(file: FileDiffMetadata | null, excerpt: GuideExcerptData) {
  if (file === null) return null;
  const rows = fileDiffRows(file);
  const shown = excerptRows(rows, excerpt);
  if (shown.length === 0) return null;
  const parsed = getRenderablePatch(
    rowsToPatch(excerpt.path, resolveFileDiffPreviousPath(file), shown),
    `pull-request-guide-excerpt:${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}`,
  );
  const fileDiff = parsed?.kind === "files" ? parsed.files[0] : undefined;
  if (fileDiff === undefined) return null;
  return { fileDiff, shown: shown.length, total: rows.length };
}

function GuideExcerpt({
  excerpt,
  file,
  loading,
  notes,
  onOpenFile,
}: {
  excerpt: GuideExcerptData;
  file: FileDiffMetadata | null;
  loading: boolean;
  notes: readonly ExcerptNoteMarker[];
  onOpenFile: (path: string) => void;
}) {
  const slice = excerptSlice(file, excerpt);
  const side = excerpt.side === "new" ? "additions" : "deletions";
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {excerpt.caption.trim() !== "" ? (
        <figcaption className="text-xs text-muted-foreground">{excerpt.caption}</figcaption>
      ) : null}
      {slice !== null ? (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border">
          <StyledFileDiff<ExcerptAnnotation>
            fileDiff={slice.fileDiff}
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "scroll",
              hunkSeparators: "simple",
            }}
            lineAnnotations={notes.map((note) => ({
              side,
              lineNumber: note.line,
              metadata: { markers: note.markers },
            }))}
            renderAnnotation={(annotation) => (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 font-sans text-xs">
                {annotation.metadata.markers.map((entry) => (
                  <span key={entry.marker} className="inline-flex items-center gap-1.5">
                    <NoteMarker marker={entry.marker} />
                    <span className="text-foreground">{entry.title}</span>
                  </span>
                ))}
              </div>
            )}
            renderHeaderMetadata={() => (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {excerpt.side === "old" ? "removed code, " : ""}showing {slice.shown} of{" "}
                  {slice.total} diff lines
                </span>
                <IconButton
                  icon={ArrowUpRight}
                  label={`Open ${excerpt.path}`}
                  size="xs"
                  onClick={() => onOpenFile(excerpt.path)}
                />
              </span>
            )}
          />
        </div>
      ) : loading ? (
        <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          Loading {excerpt.path}…
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            <span className="font-mono text-foreground">{excerpt.path}</span> lines {excerpt.start}–
            {excerpt.end} are not in the loaded diff.
          </span>
          <Button size="xs" variant="outline" onClick={() => onOpenFile(excerpt.path)}>
            Open file
          </Button>
        </div>
      )}
    </figure>
  );
}

// ── the stop ────────────────────────────────────────────────────────────

export function GuideStop({
  stop,
  index,
  stopCount,
  nextTitle,
  files,
  diffLoading,
  onStep,
  onAsk,
  onFinish,
  onOpenFile,
}: {
  stop: GuideStopData;
  index: number;
  stopCount: number;
  nextTitle: string | null;
  files: ReadonlyMap<string, FileDiffMetadata>;
  diffLoading: boolean;
  onStep: (delta: 1 | -1) => void;
  onAsk: ((question: string) => void) | null;
  onFinish: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { lettered, byExcerpt } = letterStopNotes(stop);
  const excerptPaths = new Set(stop.excerpts.map((excerpt) => excerpt.path));
  const otherFiles = stop.files.filter((file) => !excerptPaths.has(file.path));

  return (
    <article className="flex min-w-0 flex-col gap-5">
      <header className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground tabular-nums">
          Stop {index + 1} of {stopCount}
        </p>
        <div className="flex items-center gap-1">
          <IconButton
            icon={ChevronUp}
            label="Previous stop"
            size="xs"
            disabled={index === 0}
            onClick={() => onStep(-1)}
          />
          <IconButton
            icon={ChevronDown}
            label="Next stop"
            size="xs"
            disabled={index === stopCount - 1}
            onClick={() => onStep(1)}
          />
          <span aria-hidden className="ml-1 flex items-center gap-0.5">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">{stop.title}</h2>
        {stop.summary.trim() !== "" ? (
          <div className="text-sm text-muted-foreground">
            <GuideProse text={stop.summary} />
          </div>
        ) : null}
      </div>

      {stop.attention !== null ? (
        <div
          role="note"
          className="flex gap-2.5 rounded-lg border border-warning bg-warning-muted px-3 py-2.5"
        >
          <Eye aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">
              {ATTENTION_LABELS[stop.attention.kind]}
            </p>
            <div className="text-sm text-secondary-foreground">
              <GuideProse text={stop.attention.note} />
            </div>
          </div>
        </div>
      ) : null}

      {stop.excerpts.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-4">
          {stop.excerpts.map((excerpt, excerptIndex) => (
            <GuideExcerpt
              key={`${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}`}
              excerpt={excerpt}
              file={files.get(excerpt.path) ?? null}
              loading={diffLoading}
              notes={byExcerpt[excerptIndex] ?? []}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : null}
      <GuideNotes notes={lettered} />

      {otherFiles.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {stop.excerpts.length > 0 ? "Also in this stop" : "Files in this stop"}
          </h3>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
            {otherFiles.map((file) => (
              <li key={file.path} className="border-border not-first:border-t">
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs outline-none hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-foreground">{file.path}</span>
                  {file.note !== undefined && file.note.trim() !== "" ? (
                    <span className="ml-auto min-w-0 truncate text-muted-foreground">
                      {file.note}
                    </span>
                  ) : null}
                  <ChevronRight
                    aria-hidden
                    className="ml-auto size-3.5 shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stop.questions.length > 0 || onAsk !== null ? (
        <section className="flex flex-col gap-1.5">
          {stop.questions.length > 0 ? (
            <h3 className="text-xs font-medium text-muted-foreground">Questions to consider</h3>
          ) : null}
          <div className="flex flex-col items-start gap-1.5">
            {stop.questions.map((question) =>
              onAsk === null ? (
                <p key={question} className="text-sm text-foreground">
                  {question}
                </p>
              ) : (
                <button
                  key={question}
                  type="button"
                  onClick={() => onAsk(question)}
                  className="flex min-w-0 items-start gap-2 rounded-lg border border-border px-3 py-1.5 text-left text-sm text-foreground outline-none hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <MessageCircleQuestion
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="sr-only">Ask an agent: </span>
                  <span>{question}</span>
                </button>
              ),
            )}
            {onAsk !== null ? (
              <Button size="sm" variant="ghost" onClick={() => onAsk("")}>
                <MessageCircleQuestion aria-hidden className="size-3.5" />
                Ask about this stop
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        {nextTitle !== null ? (
          <Button className="min-w-0" onClick={() => onStep(1)}>
            <span className="min-w-0 truncate">Next: {nextTitle}</span>
            <ArrowRight aria-hidden className="size-3.5" />
          </Button>
        ) : (
          <Button variant="outline" onClick={onFinish}>
            <Check aria-hidden className="size-3.5" />
            Done reading
          </Button>
        )}
      </footer>
    </article>
  );
}
