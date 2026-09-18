// Row components for the new transcript.
//
// House rules, all of which exist to keep the thread quiet and cheap to scroll:
//
//  1. No element grows on hover or on load. Anything expandable either toggles
//     via row state (which reflows once, deliberately) or opens the detail
//     panel. Diffs and tool output are the panel's job, never the thread's —
//     that is what keeps a turn's cost bounded no matter what the agent did.
//  2. The only things with colour are diff counts, the running-state glyph, and
//     the turn footer's primary action. Everything else is foreground/muted
//     grey. Per-tool icon SHAPES are fine and are what the marker rows use —
//     per-tool icon COLOURS are the "moving blocks" problem in a new costume,
//     and are the thing to resist.
//  3. Rows never subscribe to the chat store or the detail-panel store. Data
//     arrives as props; actions are fired imperatively via `getState()`.

import { memo, useCallback, useState } from "react";
import {
  ChevronRight,
  Paperclip,
  Brain,
  Bookmark,
  Check,
  Circle,
  Code2,
  ChevronDown,
  MousePointer2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { StreamingMarkdown } from "./streaming-markdown";
import { openDetail } from "../stores/detail-panel-store";
import { openTurnDiff } from "../lib/open-turn-diff";
import { UserRowActions } from "./user-row-actions";
import type {
  UserRow,
  ProseRow,
  ThinkingRow,
  MarkerRow,
  MarkerGroupRow,
  SeparatorRow,
  TurnFooterRow,
  MarkerState,
  MarkerTool,
} from "../lib/turn-rows";
import { userRowMessageId } from "../lib/turn-rows";
import { M } from "../lib/row-metrics";

/** Shared by every row: the centred content column. */
function Column({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[760px] px-6", className)}>{children}</div>;
}

// ── User ───────────────────────────────────────────────────────────────────

export const UserRowView = memo(function UserRowView({
  row,
  tabId,
  priority,
  justSent = false,
  canRetry = false,
  pinScopeKey,
  onToggleExpand,
}: {
  row: UserRow;
  /** Passed rather than read from a store: house rule 3, and a primitive prop
   *  keeps the shallow-compare `memo` above intact. */
  tabId: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  /** True ONLY for the message the user sent just now (id-scoped in the
   *  store). The previous wall-clock-vs-timestamp gate animated entire
   *  restored threads (resume/replay paths stamp messages "now") and every
   *  row mounted during an early scroll — bulk entrance animations during
   *  fast scroll were a blanking contributor. */
  justSent?: boolean;
  /** True only for the thread's last user message on an agent that can rewind.
   *  Resolved by the transcript so this stays a boolean — a callback minted in
   *  the row map would defeat the memo for every row on every frame. */
  canRetry?: boolean;
  /** Pin scope for this thread — resolved once by the transcript. */
  pinScopeKey: string;
  onToggleExpand: (id: string) => void;
}) {
  return (
    // Generous space BELOW the prompt: the gap is what separates one exchange
    // from the next, and a tight one made the agent's reply read as a
    // continuation of the user's own message.
    // `pb-7` (28px) is not slack, it is the action bar's room: the bar is
    // absolutely positioned at `top-full`, so its 8px top pad and 20px icons
    // have to fit under the bubble or a hovered row overhangs into the agent's
    // reply. Reserved statically for EVERY user row — hovered or not, with an
    // expand toggle or without — so revealing the bar can never move anything
    // (house rule 1).
    <Column className="flex justify-end pt-6 pb-7">
      {/* `min-w-0` on both flex levels, `max-w-full` on the bubble: a pasted
          code block is `white-space: pre` (unwrappable), and a flex item's
          automatic minimum size floors at that intrinsic width — the pre's own
          `overflow-x: auto` cannot save an ancestor that refuses to shrink, so
          a long paste dragged the whole bubble past the viewport edge. With
          the chain capped, the fence scrolls horizontally INSIDE the bubble. */}
      <div className="relative flex min-w-0 max-w-[80%] flex-col items-end">
        {/* The prompt is markdown too. It is written in the same composer that
            accepts fences and lists, and rendering it as flat text collapsed
            every newline — a pasted snippet came back as one run-on paragraph.
            Same renderer as the agent's prose so a quoted block looks identical
            on both sides of the thread; only the type scale differs.

            Clamped by HEIGHT rather than `-webkit-line-clamp`: line-clamp needs
            inline content, and the moment the bubble holds block elements
            (paragraphs, a list, a fence) it stops clamping at all. */}
        <div
          className={cn(
            // Apple-squircle read: one big continuous radius (no clipped
            // corner), a touch more padding — iMessage-adjacent geometry.
            "atlas-prose atlas-prose--user min-w-0 max-w-full rounded-full bg-[var(--atlas-primary-muted)] px-4 py-2.5 select-text",
            // Entrance only for THE message sent just now (id-scoped).
            justSent && "atlas-bubble-in",
          )}
          style={
            row.expanded
              ? undefined
              : {
                  maxHeight: M.userMaxLines * M.userLineHeight,
                  overflow: "hidden",
                }
          }
        >
          <CachedMarkdown source={row.text} unstyled priority={priority} />
        </div>
        {row.contextBlocks > 0 && (
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-2xs text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors"
            title="Context attached with @-mentions"
          >
            <Paperclip size={10} />
            {row.contextBlocks} attached
          </button>
        )}
        <ExpandToggle row={row} onToggleExpand={onToggleExpand} />
        <UserRowActions
          tabId={tabId}
          text={row.text}
          canRetry={canRetry}
          messageId={userRowMessageId(row.id)}
          timestamp={row.timestamp}
          pinScopeKey={pinScopeKey}
          toggleAbove={clampable(row)}
        />
      </div>
    </Column>
  );
});

/**
 * "Show more" / "Show less", rendered only when the bubble is long enough that
 * the height clamp actually bites.
 *
 * In flow and always visible, unlike the action bar beneath it. That is
 * deliberate: this one is not an action on the message, it is the only way to
 * know the bubble is truncated at all. Hiding it until hover would mean a
 * clamped prompt looks like a complete one.
 */
function ExpandToggle({
  row,
  onToggleExpand,
}: {
  row: UserRow;
  onToggleExpand: (id: string) => void;
}) {
  if (!clampable(row)) return null;
  return (
    <button
      type="button"
      onClick={() => onToggleExpand(row.id)}
      className="mt-0.5 h-[18px] text-2xs text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors"
    >
      {row.expanded ? "Show less" : "Show more"}
    </button>
  );
}

/**
 * Is this bubble long enough that the height clamp bites — i.e. does it get a
 * "Show more" toggle?
 *
 * A cheap approximation rather than a measurement: a short, newline-free
 * prompt is never clamped, so the common case costs a length check and no
 * layout read. Being slightly conservative only means the affordance appears
 * on a prompt that did not strictly need it.
 *
 * Shared, not duplicated: `UserRowActions` needs the same answer to decide its
 * own top padding (the toggle sits between the bubble and the action bar, so
 * the bar must not add a second gap on top of it). The two drifting apart
 * would show up as uneven spacing on exactly the rows that have a toggle.
 */
function clampable(row: UserRow): boolean {
  return row.text.length > 220 || row.text.split("\n").length > M.userMaxLines;
}

// ── Prose ──────────────────────────────────────────────────────────────────

export const ProseRowView = memo(function ProseRowView({
  row,
  agentLabel,
  priority,
}: {
  row: ProseRow;
  agentLabel: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
}) {
  return (
    <Column className="py-2">
      {/* One left-aligned group: model, dot, time. The timestamp used to be
          pushed to the far right with `ml-auto`, which left a long empty span
          across a 760px column and read as two unrelated headers rather than
          one line of provenance. It stays against the left edge the prose
          below it also starts from.

          What answers a message is the MODEL, so the model leads; the time is
          the qualifier and follows the separator. The agent glyph is gone —
          it repeated what the model name already says, and an icon is the
          heaviest possible way to say it in a line that competes with the
          prose underneath. `agentLabel` is the fallback for a row whose model
          is unknown (an older thread, a resumed session), so the line never
          degrades to a bare timestamp with no provenance at all. */}
      {row.showHeader && (
        <div className="flex h-[22px] items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-2xs text-[var(--muted-foreground)]">
            {row.model || agentLabel}
          </span>
          <span aria-hidden className="shrink-0 text-2xs text-[var(--atlas-text-disabled)]">
            ·
          </span>
          <span className="shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
            {new Date(row.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      )}
      {/* Settled prose goes through the plain cached renderer: its root IS
          `.atlas-prose`, so the block metrics apply to real block elements and
          a scrolled-back message is a pure cache hit. The streaming tail uses
          the block-splitting renderer, where only the trailing block re-parses
          per frame. */}
      {row.streaming ? (
        <StreamingMarkdown
          source={row.text}
          streaming
          unstyled
          priority={priority}
          className="atlas-prose"
        />
      ) : (
        <CachedMarkdown source={row.text} unstyled priority={priority} className="atlas-prose" />
      )}
    </Column>
  );
});

// ── Thinking ───────────────────────────────────────────────────────────────

export const ThinkingRowView = memo(function ThinkingRowView({
  row,
  onToggleExpand,
}: {
  row: ThinkingRow;
  onToggleExpand: (id: string) => void;
}) {
  return (
    // A turn often emits several thinking blocks in a row, and at the bare
    // 26px button height they stacked into one undifferentiated block — three
    // "Thought process" lines read as a list with no items. 3px either side
    // takes the pitch to 32px (the row plus a quarter) which is enough to tell
    // them apart without turning them into paragraphs.
    <Column className="py-[3px]">
      <button
        type="button"
        onClick={() => onToggleExpand(row.id)}
        className="flex h-[26px] w-full items-center gap-2 text-left text-xs text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors"
      >
        <Brain size={11} className={cn(row.streaming && "atlas-marker-running")} />
        <span>{row.streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronRight
          size={11}
          className={cn("transition-transform", row.expanded && "rotate-90")}
        />
      </button>
      {row.expanded && (
        <div className="pb-3 pl-[19px]">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[19px] text-[var(--muted-foreground)] select-text">
            {row.text}
          </pre>
        </div>
      )}
    </Column>
  );
});

// ── Marker ─────────────────────────────────────────────────────────────────

/**
 * A tool call's leading glyph: state first, shape second.
 *
 * The transcript briefly gave every call a per-tool icon (terminal, book,
 * pencil) at 15px. It read as a toolbar: eleven shapes at a size that competes
 * with the prose, on rows that are meant to be skimmed past. What a reader
 * actually scans a settled turn for is "did anything go wrong", so state is
 * back in the glyph — a tick for done, a red cross for failed — at the muted
 * 11px the rest of the row runs at.
 *
 * `think` is the one exception, and it is the user's call: a delegated
 * sub-agent is a different KIND of work from a file read, not just another
 * tool, so it keeps the brain. It still tints red on failure, because losing
 * the state signal on the one row type that can quietly fail is not a trade
 * worth making.
 */
function MarkerGlyph({ state, tool }: { state: MarkerState; tool: MarkerTool }) {
  if (tool === "think")
    return (
      <Brain
        size={11}
        className={cn(
          state === "failed"
            ? "text-[var(--atlas-status-error-foreground)]"
            : "text-[var(--muted-foreground)]",
        )}
      />
    );
  if (state === "failed")
    return <X size={11} className="text-[var(--atlas-status-error-foreground)]" />;
  if (state === "done") return <Check size={11} className="text-[var(--muted-foreground)]" />;
  if (state === "running")
    return (
      <Circle
        size={9}
        className="atlas-marker-running fill-[var(--primary)] text-[var(--primary)]"
      />
    );
  return <Circle size={9} className="text-[var(--muted-foreground)]" />;
}

/**
 * The folded sequence's own glyph: one filled cursor, the whole block's verdict.
 *
 * Filled rather than outline so it holds at 11px, and a single shape rather
 * than the first bucket's tool icon — the summary sentence beside it ("Read
 * files, ran commands") already says what the block did, and that sentence is
 * what tells one block from the next. Red when any call in the sequence
 * failed, which is the one thing worth surfacing before the reader opens it.
 */
function GroupGlyph({ failed, running }: { failed: boolean; running: boolean }) {
  return (
    <MousePointer2
      size={11}
      className={cn(
        "fill-current",
        failed
          ? "text-[var(--atlas-status-error-foreground)]"
          : running
            ? "text-[var(--primary)]"
            : "text-[var(--muted-foreground)]",
      )}
    />
  );
}

/**
 * One tool call: a single muted line, and nothing else.
 *
 * The group expands, while each action stays one line. Clicking an action with
 * output or a diff opens its detail view; the trailing chevron is what says so.
 */
export const MarkerRowView = memo(function MarkerRowView({
  row,
  tabId,
  embedded = false,
}: {
  row: MarkerRow;
  tabId: string;
  embedded?: boolean;
}) {
  const clickable = row.opens !== "none";
  const onClick = useCallback(() => {
    if (row.opens === "diff") {
      // Changes get the real viewer, not the sidebar. The turn id is what the
      // diff is scoped by; the path just says which file to land on.
      openTurnDiff(row.turnId, row.path);
    } else if (row.opens === "output") {
      openDetail(tabId, { kind: "output", toolCallId: row.toolCallId });
    }
  }, [row.opens, row.path, row.toolCallId, tabId]);

  const line = (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? onClick : undefined}
      className={cn(
        "atlas-marker w-full min-w-0 text-left text-xs text-[var(--muted-foreground)]",
        clickable && "cursor-pointer hover:text-[var(--secondary-foreground)]",
        row.state === "running" && "atlas-marker-running",
      )}
      title={
        clickable ? `${row.cmd ?? `${row.verb} ${row.detail}`} — open in side panel` : undefined
      }
    >
      <span className="flex w-3 shrink-0 justify-center">
        <MarkerGlyph state={row.state} tool={row.tool} />
      </span>
      <span className="shrink-0">{row.verb}</span>
      {row.detail && (
        <span className="min-w-0 truncate font-mono text-[var(--muted-foreground)]/85">
          {row.detail}
        </span>
      )}
      {(row.added > 0 || row.removed > 0) && (
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums">
          {row.added > 0 && (
            <span className="text-[var(--atlas-diff-added-text)]">+{row.added}</span>
          )}
          {row.removed > 0 && (
            <span className="ml-1 text-[var(--atlas-status-error-foreground)]">−{row.removed}</span>
          )}
        </span>
      )}
      {clickable && (
        <ChevronRight
          size={11}
          className={cn("shrink-0", !row.added && !row.removed && "ml-auto")}
        />
      )}
    </button>
  );
  return embedded ? line : <Column>{line}</Column>;
});

/**
 * A folded sequence of consecutive tool calls, kept between the prose around it.
 *
 * `Tool calls · 6s · 8 calls` over a separate "Show tool calls" button became a
 * single sentence you click — "Read files, ran commands" — matching the Codex
 * desktop app. The wall time and the call/edit counts went with the old header;
 * the turn footer below already carries "N files changed +x −y", so the only
 * thing actually lost is the duration.
 *
 * The chevron appears on hover and stays visible when open. The action list is
 * height-bounded so a long run does not take over the transcript.
 */
export const MarkerGroupRowView = memo(function MarkerGroupRowView({
  row,
  tabId,
  onExpandTurn,
}: {
  row: MarkerGroupRow;
  tabId: string;
  onExpandTurn: (turnId: string) => void;
}) {
  // Derived rather than carried on the row: the projection would have to
  // recompute it on every marker state change anyway, and it is a scan of a
  // list the row already holds.
  const failed = row.markers.some((marker) => marker.state === "failed");
  return (
    <Column className="py-1.5">
      <button
        type="button"
        aria-expanded={row.open}
        aria-controls={`${row.id}:actions`}
        onClick={() => onExpandTurn(row.id)}
        className="atlas-marker group/tool-summary max-w-full cursor-pointer text-left text-xs text-[var(--secondary-foreground)] hover:text-[var(--foreground)]"
      >
        <span className="flex w-3 shrink-0 justify-center">
          <GroupGlyph failed={failed} running={row.running} />
        </span>
        <span className={cn("min-w-0 truncate", row.running && "atlas-thinking-shimmer")}>
          {row.running ? row.liveLabel : row.summary}
        </span>
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0",
            row.open
              ? "rotate-90 opacity-100"
              : "opacity-0 group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100",
          )}
        />
      </button>
      {row.open && (
        // Laid out in the thread, not in a 240px scroller. A nested scroll area
        // inside a scrolling transcript is two scrollbars fighting over the
        // same wheel gesture, and it hides the end of the list behind an
        // interaction the reader has to discover. Opening a sequence is a
        // deliberate act on one turn at a time, so its rows are just rows.
        <div id={`${row.id}:actions`}>
          {row.markers.map((marker) => (
            <MarkerRowView key={marker.id} row={marker} tabId={tabId} embedded />
          ))}
        </div>
      )}
    </Column>
  );
});

// ── Separator ──────────────────────────────────────────────────────────────

export const SeparatorRowView = memo(function SeparatorRowView({ row }: { row: SeparatorRow }) {
  return (
    <Column className="flex h-[34px] items-center">
      <div className="flex w-full select-none items-center gap-2">
        <span className="h-px flex-1 bg-[var(--atlas-border-subtle)]" />
        <span className="shrink-0 text-2xs text-[var(--muted-foreground)]">{row.label}</span>
        <span className="h-px flex-1 bg-[var(--atlas-border-subtle)]" />
      </div>
    </Column>
  );
});

// ── Turn footer ────────────────────────────────────────────────────────────

export const TurnFooterRowView = memo(function TurnFooterRowView({
  row,
  onSaveKb,
}: {
  row: TurnFooterRow;
  onSaveKb: () => void;
}) {
  // `row.files` is the first three; `row.allFiles` is everything. The overflow
  // line is a disclosure, not a dead count.
  const [showAll, setShowAll] = useState(false);
  const files = showAll ? row.allFiles : row.files;
  const edits = row.allFiles.filter((f) => f.kind === "edit");
  const added = edits.reduce((s, f) => s + f.added, 0);
  const removed = edits.reduce((s, f) => s + f.removed, 0);
  const label =
    edits.length > 0
      ? `${edits.length} file${edits.length === 1 ? "" : "s"} changed`
      : `${row.allFiles.length} file${row.allFiles.length === 1 ? "" : "s"} read`;

  return (
    <Column className="pb-5 pt-2">
      {/* Full measure width, lifted off the background so it reads as the
          turn's result rather than another paragraph. Paths show basename only:
          the leading directories are identical on every row and were eating the
          width. */}
      <div className="overflow-hidden rounded-xl border border-[var(--atlas-element-active)] bg-[var(--atlas-element-hover)]">
        <div className="flex h-[34px] items-center gap-2 px-3.5">
          <span className="label">{label}</span>
          {(added > 0 || removed > 0) && (
            <span className="font-mono text-2xs tabular-nums">
              {added > 0 && <span className="text-[var(--atlas-diff-added-text)]">+{added}</span>}
              {removed > 0 && (
                <span className="ml-1 text-[var(--atlas-status-error-foreground)]">−{removed}</span>
              )}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <FooterPill
              icon={<Bookmark size={11} />}
              label="Save"
              title="Save this thread to the knowledge base"
              onClick={onSaveKb}
            />
            {edits.length > 0 && (
              <FooterPill
                icon={<Code2 size={11} />}
                label="Show changes"
                // The whole turn: its files fill the tree and the first opens.
                onClick={() => openTurnDiff(row.turnId)}
              />
            )}
          </div>
        </div>
        <div className="border-t border-[var(--atlas-element-selected)] px-3.5 py-2">
          {files.map((f) => (
            <div key={f.path} className="flex h-[24px] items-center gap-2 text-xs" title={f.path}>
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-2xs font-semibold",
                  f.kind === "edit"
                    ? f.created
                      ? "text-[var(--atlas-diff-added-text)]"
                      : "text-[var(--atlas-status-warning-foreground)]"
                    : "text-[var(--muted-foreground)]",
                )}
              >
                {f.kind === "edit" ? (f.created ? "A" : "M") : "R"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--secondary-foreground)]">
                {baseName(f.path)}
              </span>
              {f.kind === "edit" && (f.added > 0 || f.removed > 0) && (
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  {f.added > 0 && (
                    <span className="text-[var(--atlas-diff-added-text)]">+{f.added}</span>
                  )}
                  {f.removed > 0 && (
                    <span className="ml-1 text-[var(--atlas-status-error-foreground)]">
                      −{f.removed}
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
          {row.overflow > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex h-[20px] cursor-pointer items-center gap-1 text-2xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--secondary-foreground)]"
            >
              <ChevronDown
                size={10}
                className={cn("transition-transform", showAll && "rotate-180")}
              />
              {showAll ? "Show fewer" : `+${row.overflow} more`}
            </button>
          )}
        </div>
      </div>
    </Column>
  );
});

/** Last path segment — the directories repeat on every row and cost width. */
function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function FooterPill({
  icon,
  label,
  onClick,
  primary,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "inline-flex h-[20px] cursor-pointer items-center gap-1 rounded-full border px-2",
        "text-2xs font-medium leading-none transition-colors",
        primary
          ? "border-[var(--primary)]/40 bg-[var(--atlas-primary-muted)] text-[var(--primary)] hover:bg-[var(--primary)]/20"
          : "border-border bg-[var(--atlas-element-hover)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
