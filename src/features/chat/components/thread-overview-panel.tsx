// The thread overview — a rail docked to the right of the conversation.
//
// It answers the questions a long turn raises that the thread itself answers
// badly, because the answer is scattered through it: how many children are
// running, what this conversation has changed, what it remembered. Claude
// Desktop's right rail ("Background tasks · 3 running") is the reference.
//
// Like the comments panel it is DOCKED, not an overlay: it takes layout space
// and the transcript reflows narrower beside it. An overlay over a transcript
// the reader is following would cover the thing the rail is describing.
//
// Contract with the transcript, inherited from `detail-panel`: opening,
// resizing or collapsing a section must not re-render a single transcript row.
// Nothing here writes to the chat store, and the rail's own state lives in
// `thread-overview-store`.

import { useMemo, useRef } from "react";
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
import { HEADER_INSET } from "../lib/row-metrics";
import { useChatStore } from "../stores/chat-store";
import {
  OVERVIEW_SECTIONS,
  SECTION_TITLE,
  useThreadOverviewStore,
  type ListedSection,
  type OverviewSection,
} from "../stores/thread-overview-store";
import { useSubagents } from "../hooks/use-subagents";
import { elapsedMs, isRunning, tallySubagents } from "../lib/subagents";
import { changesStatus, mergeChanges, tallyChanges } from "../lib/thread-overview";
import { useSessionFiles } from "../lib/session-files";
import { LiveElapsed, settledFigure } from "./transcript-rows";
import { SessionBody } from "./thread-overview-session";

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
  title,
  badge,
  badgeTitle,
  children,
}: {
  id: OverviewSection;
  /** Overrides the section's own title — the Session card shows the thread's. */
  title?: string;
  /** How many items the card holds ("14"), or what they are doing ("3
   *  running"), in a badge beside the title. Empty hides the badge. */
  badge: string;
  /** More than the badge has room for, on hover ("+58 −26"). */
  badgeTitle?: string;
  children: React.ReactNode;
}) {
  const collapsed = useThreadOverviewStore((s) => Boolean(s.collapsed[id]));
  const SectionIcon = SECTION_ICON[id];
  const { toggleSection } = useThreadOverviewStore.use.actions();
  // The body scrolls on its own past a cap, so one long list (a thread that
  // touched forty files) cannot push the other cards out of reach. The fade
  // marks "more below" and only while there is: on a list that fits, or one
  // scrolled to its end, it would just dim the last row.
  const bodyRef = useRef<HTMLDivElement>(null);
  const { bottom: moreBelow } = useScrollEdges(bodyRef, [children, collapsed]);
  return (
    // `shrink-0`: the rail is a flex column that scrolls. A shrinkable card
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
          {title || SECTION_TITLE[id]}
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
              {/* Opens the child's own body beside the thread, the same target
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
 * file the session changed however it changed it, and the thread's own
 * per-turn tally, which carries the line counts and the running turn's edits
 * the moment they land. Either alone was wrong in a way the reader could not
 * see — the tally missed every shell edit, and read nothing until turn end.
 */
/** Source Control's colours for the same letters (`changed-files-tree.tsx`). */
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
  // Clicking a file shows the thread's changes beside it, at that file. Needs
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
  // No card at all when this thread remembered nothing — which is most
  // threads. A card carrying only its own title is the empty-section problem
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

// ── Panel ──────────────────────────────────────────────────────────────────

export function ThreadOverviewPanel({
  tabId,
  title,
  onOpenSearch,
}: {
  tabId: string;
  /** The thread's title, as the chat header shows it — heads the Session card. */
  title?: string;
  /** Opens the thread's find bar — the Session card's search button. */
  onOpenSearch?: () => void;
}) {
  const width = useThreadOverviewStore.use.width();
  const projectPath = useAppStore.use.currentProject()?.path ?? null;

  return (
    // No panel chrome: no border, no header, no fill of its own. The cards ARE
    // the surface, floating on the conversation's own background — which is
    // what lets the subagent view open OVER this as a full panel without two
    // competing frames on the same edge.
    <aside
      aria-label="Thread overview"
      // The header bar floats over the CONVERSATION column only, so a rail
      // starting at y=0 sits beside its icons rather than under them. Reserve
      // the bar's height here too and the first card begins on the same line
      // the transcript's first row does.
      style={{ width, paddingTop: HEADER_INSET }}
      className="hide-scrollbar flex h-full max-w-[50%] shrink-0 flex-col gap-2 overflow-y-auto pr-2 pb-2 pl-5"
    >
      <Section id="session" title={title} badge="">
        <SessionBody tabId={tabId} projectPath={projectPath} onOpenSearch={onOpenSearch} />
      </Section>
      {OVERVIEW_SECTIONS.map((id) => {
        const View = SECTION_VIEW[id];
        return <View key={id} tabId={tabId} />;
      })}
    </aside>
  );
}
