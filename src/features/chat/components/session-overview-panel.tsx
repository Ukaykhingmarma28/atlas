// The session overview: a card over the session's top-right, shown and hidden
// by its title-bar button.
//
// It answers the questions a long turn raises that the session itself answers
// badly, because the answer is scattered through it: how many children are
// running, what this session has changed, what it remembered.
//
// Showing it is a toggle and nothing else. It never takes layout space from
// the transcript or the composer: docked, it is drawn into room the panel
// keeps at its top-right whether or not it shows (`context-dock.ts`); where
// there is no such room it is a popover under its button. Either way it is
// capped at the height above the composer, sheds its least useful rows before
// it scrolls (`session-overview-layout.ts`), and scrolls inside itself after.
//
// Contract with the transcript, inherited from `detail-panel`: opening the
// card or collapsing a section must not re-render a single transcript row.
// Nothing here writes to the chat store, and the card's own state lives in
// `session-overview-store`.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileDiff,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { HUD } from "@/ui/hud";

import { cn } from "@/lib/utils";
import { useScrollEdges } from "@/ui/scroll-fade";
import { useAppStore } from "@/features/app/stores/app-store";
import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { KIND_ICON, kindLabel } from "@/features/memory/lib/memory-kind-icon";
import { openMemoryEntry } from "@/features/memory/lib/open-memory-entry";
import { useSessionMemoryWrites } from "@/features/memory/lib/use-session-memory-writes";

import { openDetail } from "../stores/detail-panel-store";
import { useChatStore } from "../stores/chat-store";
import {
  OVERVIEW_SECTIONS,
  SECTION_TITLE,
  useSessionOverviewStore,
  type ListedSection,
  type OverviewSection,
} from "../stores/session-overview-store";
import { useSubagents } from "../hooks/use-subagents";
import { elapsedMs, isRunning, tallySubagents } from "../lib/subagents";
import { changesStatus, mergeChanges, tallyChanges } from "../lib/session-overview";
import { useSessionFiles } from "../lib/session-files";
import { LiveElapsed, settledFigure } from "./transcript-rows";
import { SessionBody } from "./session-overview-session";
import {
  UNMEASURED,
  resolveOverviewDensity,
  type OverviewDensity,
  type OverviewHeights,
} from "../lib/session-overview-layout";

// ── Section chrome ─────────────────────────────────────────────────────────

/**
 * One section, as its own card.
 *
 * Separate cards rather than a bordered panel of stacked rows, which is how
 * Claude Desktop's rail reads and why it reads well: the sections are
 * unrelated — a subagent has nothing to do with a diff stat — and a shared
 * frame implies they belong to one list you read top to bottom. Floating each
 * one lets a reader take in just the card they came for, and lets a section
 * with nothing in it simply not be there.
 *
 * The title row always carries its count, open or collapsed. That count is
 * the whole value of a collapsed card: a section that hid it would have to be
 * opened before it said anything.
 */
/** Each card's glyph, beside its title. */
const SECTION_ICON: Record<OverviewSection, LucideIcon> = {
  session: MessagesSquare,
  subagents: Bot,
  changes: FileDiff,
  memories: Brain,
};

function Section({
  id,
  badge,
  badgeTitle,
  children,
}: {
  id: OverviewSection;
  /** How many items the card holds ("14"), or what they are doing ("3
   *  running"), in a badge beside the title. Empty hides the badge. */
  badge: string;
  /** More than the badge has room for, on hover ("+58 −26"). */
  badgeTitle?: string;
  children: React.ReactNode;
}) {
  const collapsed = useSessionOverviewStore((s) => Boolean(s.collapsed[id]));
  const SectionIcon = SECTION_ICON[id];
  const { toggleSection } = useSessionOverviewStore.use.actions();
  // The body scrolls on its own past a cap, so one long list (a session that
  // touched forty files) cannot push the other cards out of reach. The fade
  // marks "more below" and only while there is: on a list that fits, or one
  // scrolled to its end, it would just dim the last row.
  const bodyRef = useRef<HTMLDivElement>(null);
  const { bottom: moreBelow } = useScrollEdges(bodyRef, [children, collapsed]);
  return (
    // `shrink-0`: the card is a flex column that scrolls. A shrinkable card
    // was squeezed instead once the cards outgrew it, clipping its own rows.
    <section className="shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => toggleSection(id)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left hover:bg-[var(--muted)]"
      >
        <SectionIcon size={12} className="shrink-0 text-[var(--muted-foreground)]" aria-hidden />
        <span className="min-w-0 truncate text-xs font-medium text-[var(--secondary-foreground)]">
          {SECTION_TITLE[id]}
        </span>
        {badge && (
          // The hint overlay's keycap (⌘⌥Space): the frosted chip the eye
          // already knows as "a label to read", not a grey smudge.
          <span
            title={badgeTitle}
            className={cn(
              "inline-flex shrink-0 items-center rounded-full px-1.5 text-2xs leading-4 font-semibold tracking-wide text-foreground tabular-nums",
              HUD,
            )}
          >
            {badge}
          </span>
        )}
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={cn(
            "ml-auto shrink-0 text-[var(--muted-foreground)] transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {!collapsed && (
        <div
          ref={bodyRef}
          className={cn(
            "hide-scrollbar max-h-64 overflow-y-auto overscroll-contain px-1 pb-1.5",
            moreBelow && "atlas-scroll-mask-b",
          )}
        >
          {children}
        </div>
      )}
    </section>
  );
}

/** What a section says when it has nothing — one muted line, never an empty
 *  box with a heading over it. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1 text-2xs text-[var(--atlas-text-disabled)]">{children}</p>;
}

// ── Sections ───────────────────────────────────────────────────────────────

function SubagentsSection({ tabId }: { tabId: string }) {
  const children = useSubagents(tabId);
  const tally = useMemo(() => tallySubagents(children), [children]);
  // "3 running" while any is live, else the total — which is the figure
  // Claude Desktop puts beside its own Background tasks header, and the only
  // one that changes while you watch.
  const status =
    tally.running > 0 ? `${tally.running} running` : tally.total > 0 ? `${tally.total}` : "";

  return (
    <Section id="subagents" badge={status}>
      {children.length === 0 ? (
        <Empty>No agents delegated to.</Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {children.map((child) => (
            <li key={child.toolCallId}>
              {/* Opens the child's own body beside the session, the same target
                  its transcript row opens — one subagent, one place to read it. */}
              <button
                type="button"
                onClick={() =>
                  openDetail(tabId, { kind: "subagent", toolCallId: child.toolCallId })
                }
                // The hover rectangle is the row, so it carries the row's
                // padding: hanging it on a `py-0.5` line inside the card's own
                // padding put the highlight hard against the card's border
                // with the orb sitting on the edge of it.
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--muted)]"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    child.status === "running"
                      ? "bg-[var(--primary)] atlas-marker-running"
                      : child.status === "failed"
                        ? "bg-[var(--atlas-status-error-foreground)]"
                        : "bg-[var(--atlas-text-disabled)]",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--secondary-foreground)]">
                  {child.name.trim() || "Subagent"}
                </span>
                <span className="shrink-0 font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums">
                  {isRunning(child) ? (
                    <LiveElapsed startedAt={child.startedAtMs} minMs={1000} />
                  ) : (
                    settledFigure(elapsedMs(child, Date.now()))
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * Two sources, joined (`mergeChanges`): the capture record, which is every
 * file the session changed however it changed it, and the session's own
 * per-turn tally, which carries the line counts and the running turn's edits
 * the moment they land. Either alone was wrong in a way the reader could not
 * see — the tally missed every shell edit, and read nothing until turn end.
 */
/** The diff's file tree's colours for the same letters (`diff-file-tree.tsx`). */
const STATUS_COLOR = {
  A: "var(--atlas-status-success-foreground)",
  M: "var(--atlas-status-warning-foreground)",
  D: "var(--atlas-status-error-foreground)",
} as const;
const STATUS_LABEL = { A: "Added", M: "Modified", D: "Deleted" } as const;

function ChangesSection({ tabId }: { tabId: string }) {
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const messages = useChatStore((s) => s.sessions[tabId]?.messages);
  // The running turn's scratch. Replaced per tool upsert, which is the rate a
  // reader watching the turn wants; the rows under it are few and cheap.
  const live = useChatStore((s) => s.sessions[tabId]?.turnScratch?.tools);
  const recorded = useSessionFiles(projectPath, acpSessionId);
  const tally = useMemo(() => tallyChanges(messages ?? [], live), [messages, live]);
  const rows = useMemo(
    () => mergeChanges(recorded, tally, projectPath ?? ""),
    [recorded, tally, projectPath],
  );
  // Clicking a file shows the session's changes beside it, at that file. Needs
  // a session id: the tab is keyed by it and reads the record through it.
  const open =
    projectPath && acpSessionId
      ? (file: string) =>
          openSessionChanges({
            projectPath,
            sessionId: acpSessionId,
            file,
            title: useLayoutStore.getState().tabs.find((t) => t.id === tabId)?.title,
          })
      : null;
  return (
    <Section
      id="changes"
      badge={rows.length > 0 ? `${rows.length}` : ""}
      badgeTitle={changesStatus(rows)}
    >
      {rows.length === 0 ? (
        <Empty>
          {tally.readCount > 0 ? `${tally.readCount} files read, none changed.` : "No changes yet."}
        </Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((file) => (
            <li
              key={file.path}
              role={open ? "button" : undefined}
              tabIndex={open ? 0 : undefined}
              onClick={open ? () => open(file.path) : undefined}
              onKeyDown={
                open
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(file.path);
                      }
                    }
                  : undefined
              }
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1",
                open &&
                  "cursor-pointer outline-none hover:bg-[var(--atlas-element-hover)] focus-visible:ring-1 focus-visible:ring-[var(--ring)]",
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {file.status ? (
                  <span
                    className="font-mono text-2xs font-medium"
                    style={{ color: STATUS_COLOR[file.status] }}
                    aria-label={STATUS_LABEL[file.status]}
                  >
                    {file.status}
                  </span>
                ) : (
                  <FileIcon path={file.path} size={12} />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-[var(--secondary-foreground)]",
                  file.deleted && "line-through opacity-60",
                )}
                title={file.path}
              >
                {file.path.split("/").pop()}
              </span>
              {file.added !== undefined &&
              file.removed !== undefined &&
              (file.added > 0 || file.removed > 0) ? (
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  <span className="text-[var(--atlas-diff-added-text)]">+{file.added}</span>
                  <span className="ml-1 text-[var(--atlas-status-error-foreground)]">
                    −{file.removed}
                  </span>
                </span>
              ) : (
                <ChevronRight
                  size={12}
                  className="shrink-0 text-[var(--muted-foreground)]"
                  aria-hidden
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function MemoryKindGlyph({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] ?? Brain;
  return (
    <Icon
      size={12}
      strokeWidth={1.5}
      className="shrink-0 text-[var(--muted-foreground)]"
      aria-label={kindLabel(kind)}
    />
  );
}

function MemoriesSection({ tabId }: { tabId: string }) {
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const { writes } = useSessionMemoryWrites(projectPath, acpSessionId);
  // No card at all when this session remembered nothing — which is most
  // sessions. A card carrying only its own title is the empty-section problem
  // these cards exist to avoid, and separate cards make "not there" an option
  // a bordered panel of stacked rows never had.
  if (writes.length === 0) return null;
  return (
    <Section id="memories" badge={`${writes.length}`}>
      <ul className="m-0 list-none p-0">
        {writes.map((write) => (
          <li
            key={write.id}
            // Opens the entry in the Memory tab. A forgotten or archived one
            // has nothing to open, so it stays plain text.
            role={write.live ? "button" : undefined}
            tabIndex={write.live ? 0 : undefined}
            onClick={write.live ? () => openMemoryEntry(write.id) : undefined}
            onKeyDown={
              write.live
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openMemoryEntry(write.id);
                    }
                  }
                : undefined
            }
            className={cn(
              "flex items-center gap-2 rounded px-2 py-1 text-xs text-[var(--secondary-foreground)]",
              write.live
                ? "cursor-pointer outline-none hover:bg-[var(--atlas-element-hover)] focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                : "opacity-60",
            )}
            title={`${kindLabel(write.kind)}: ${write.content}`}
          >
            {/* The kind's glyph, as under the turn that wrote it. */}
            <MemoryKindGlyph kind={write.kind} />
            <span className={cn("min-w-0 flex-1 truncate", !write.live && "line-through")}>
              {write.content || "(forgotten)"}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const SECTION_VIEW: Record<ListedSection, (props: { tabId: string }) => React.ReactNode> = {
  subagents: SubagentsSection,
  changes: ChangesSection,
  memories: MemoriesSection,
};

// ── Card ───────────────────────────────────────────────────────────────────

export type OverviewPresentation = "docked" | "popover";

/** Slack for subpixel rounding, so a card measured to fit exactly is not
 *  stepped down by half a pixel. */
const MEASURE_SLACK = 1;

/**
 * The card, in either form. `maxHeight` is the room above the composer (the
 * caller measures it); the density steps and the internal scroll both work
 * inside it, so the card can never reach the composer.
 */
export function SessionOverviewCard({
  tabId,
  onOpenSearch,
  presentation,
  maxHeight,
}: {
  tabId: string;
  /** Opens the session's find bar — the Session card's search button. */
  onOpenSearch?: () => void;
  presentation: OverviewPresentation;
  /** `null` while unmeasured: the card shows in full under its CSS cap. */
  maxHeight: number | null;
}) {
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  // Which sections are collapsed changes every step's height, so it is part
  // of what a measurement is valid for. Without it, a card that stepped down
  // to `essential` (which is never measured) would stay there after the
  // reader collapsed the section that pushed it.
  const collapsedKey = useSessionOverviewStore((s) => Object.keys(s.collapsed).sort().join(","));
  const key = `${tabId}:${presentation}:${collapsedKey}`;
  const [measured, setMeasured] = useState<{ key: string; heights: OverviewHeights }>({
    key,
    heights: UNMEASURED,
  });
  const heights = measured.key === key ? measured.heights : UNMEASURED;
  const density: OverviewDensity =
    maxHeight === null ? "full" : resolveOverviewDensity(maxHeight, heights);

  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!content || density === "essential") return;
    const measure = () => {
      const frame = content.parentElement;
      // The content's own height plus the frame's padding and border: what
      // the card would need to show this step without scrolling.
      const chrome = frame ? frame.offsetHeight - frame.clientHeight + paddingY(frame) : 0;
      const next = Math.max(1, content.offsetHeight + chrome - MEASURE_SLACK);
      setMeasured((current) => {
        const base = current.key === key ? current.heights : UNMEASURED;
        return current.key === key && base[density] === next
          ? current
          : { key, heights: { ...base, [density]: next } };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [content, density, key]);

  return (
    <div
      aria-label="Session overview"
      role="region"
      data-session-overview-card={presentation}
      data-density={density}
      style={maxHeight === null ? undefined : { maxHeight }}
      className={cn(
        "hide-scrollbar flex min-h-0 w-[300px] flex-col overflow-y-auto overscroll-contain",
        // Docked, the cards float on the conversation's own background, in
        // room the transcript leaves free. As a popover they lie over the
        // transcript, so they get a surface under them.
        presentation === "popover" &&
          "rounded-lg border border-border bg-popover p-1.5 text-foreground shadow-md",
      )}
    >
      <div ref={setContent} className="flex flex-col gap-2">
        {density !== "essential" && (
          <Section id="session" badge="">
            <SessionBody
              tabId={tabId}
              projectPath={projectPath}
              onOpenSearch={onOpenSearch}
              showProject={density === "full"}
            />
          </Section>
        )}
        {OVERVIEW_SECTIONS.map((id) => {
          const View = SECTION_VIEW[id];
          return <View key={id} tabId={tabId} />;
        })}
      </div>
    </div>
  );
}

/** The frame's vertical padding, which `clientHeight` includes. */
function paddingY(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
}
