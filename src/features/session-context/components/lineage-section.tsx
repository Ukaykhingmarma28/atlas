// The agents this session delegated to — the Lineage group.
//
// The title carries the running count ("Lineage · 2 running");
// live children list first, expanded; finished ones fold under a collapsed
// "Previous agents (N)" header; each list pages six at a time, then twelve,
// behind "Show N more"; the header's ⋯ menu holds the thread-level action.
//
// Atlas has no record of a session's parent, fork or context transfer, so
// there are no such edges to show. An Atlas fork opens a new tab and remembers nothing of where
// it came from, so there is no "Parent thread" row to show. The ⋯ menu offers
// the fork itself instead, gated on the agent advertising it exactly as the
// chat header's menu is.

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Ellipsis, GitFork, Plus } from "lucide-react";

import { catalogEntry } from "@/features/agents/lib/agent-meta";
import { LiveElapsed, settledFigure } from "@/features/chat/components/transcript-rows";
import { useSubagents } from "@/features/chat/hooks/use-subagents";
import { forkSessionToNewTab } from "@/features/chat/lib/fork-session";
import { displayName, elapsedMs, isRunning, isTerminal } from "@/features/chat/lib/subagents";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { openDetail } from "@/features/chat/stores/detail-panel-store";
import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import type { Subagent } from "@/types/agent";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

import { ContextRow, ContextSection, RowLabel, RowMeta } from "./context-rows";

/** How many children a list shows first, then how many each "Show N more" adds. */
const INITIAL_COUNT = 6;
const PAGE_COUNT = 12;

export function LineageSection({ tabId }: { tabId: string }) {
  const children = useSubagents(tabId);
  const canFork = useChatStore((s) => {
    const sess = s.sessions[tabId];
    if (!sess?.acpAgentId || !sess.acpSessionId || !sess.agentType) return false;
    return catalogEntry(sess.agentType)?.supportsFork === true;
  });
  const { active, previous } = useMemo(() => {
    const active: Subagent[] = [];
    const previous: Subagent[] = [];
    for (const child of children) (isTerminal(child.status) ? previous : active).push(child);
    return { active, previous };
  }, [children]);
  const running = active.filter(isRunning).length;

  if (children.length === 0 && !canFork) return null;
  return (
    <ContextSection
      title={running > 0 ? `Lineage · ${running} running` : "Lineage"}
      actions={canFork ? <LineageMenu tabId={tabId} /> : null}
    >
      {children.length === 0 ? (
        <p className="px-2.5 pb-1 text-2xs text-muted-foreground">No agents delegated to.</p>
      ) : (
        <>
          <LineageGroup label={null} rows={active} tabId={tabId} defaultExpanded />
          <LineageGroup label="Previous agents" rows={previous} tabId={tabId} />
        </>
      )}
    </ContextSection>
  );
}

function LineageMenu({ tabId }: { tabId: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<IconButton icon={Ellipsis} size="xs" label="More session actions" />}
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => forkSessionToNewTab(tabId)}>
          <GitFork />
          Branch into a new tab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One lineage group: an optional collapsible header, then a paged list. */
function LineageGroup({
  label,
  rows,
  tabId,
  defaultExpanded = false,
}: {
  label: string | null;
  rows: Subagent[];
  tabId: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [visible, setVisible] = useState(INITIAL_COUNT);
  if (rows.length === 0) return null;
  const failed = rows.filter((r) => r.status === "failed").length;
  const shown = rows.slice(0, visible);
  const hidden = rows.length - shown.length;
  return (
    <div>
      {label && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-left text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:bg-element-hover"
        >
          <ChevronDown
            size={12}
            aria-hidden
            className={cn("shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
          <span className="min-w-0 flex-1 truncate">
            {label}
            {!expanded && ` (${rows.length})`}
          </span>
          {failed > 0 && <span className="shrink-0 text-error">{failed} failed</span>}
        </button>
      )}
      {expanded && (
        <>
          {/* Plain overflow, as T3 notes: this sits inside a popover that can
              itself scroll, where a nested virtual viewport measures badly. */}
          <ul
            aria-label={label ?? "Running agents"}
            className="m-0 max-h-56 list-none overflow-y-auto overscroll-contain p-0"
          >
            {shown.map((child) => (
              <li key={child.toolCallId}>
                <LineageRow tabId={tabId} child={child} />
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <ContextRow
              onClick={() => setVisible((n) => n + PAGE_COUNT)}
              className="text-muted-foreground"
            >
              <Plus size={14} className="shrink-0" aria-hidden />
              <RowLabel>Show {Math.min(hidden, PAGE_COUNT)} more</RowLabel>
            </ContextRow>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<Subagent["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  interrupted: "Stopped",
};

function LineageRow({ tabId, child }: { tabId: string; child: Subagent }) {
  const live = isRunning(child);
  let trailing: ReactNode;
  if (child.status === "failed") trailing = <RowMeta className="text-error">Failed</RowMeta>;
  else if (live)
    trailing = (
      <RowMeta>
        <LiveElapsed startedAt={child.startedAtMs} minMs={1000} />
      </RowMeta>
    );
  else trailing = <RowMeta>{settledFigure(elapsedMs(child, Date.now()))}</RowMeta>;
  return (
    // Opens the child's own body beside the thread — the same target its
    // transcript row and the overview rail open.
    <ContextRow
      onClick={() => openDetail(tabId, { kind: "subagent", toolCallId: child.toolCallId })}
      title={`${displayName(child)} — ${STATUS_LABEL[child.status]}`}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          live
            ? "bg-primary atlas-marker-running"
            : child.status === "failed"
              ? "bg-error"
              : "bg-muted-foreground",
        )}
      />
      <RowLabel>{displayName(child)}</RowLabel>
      {trailing}
    </ContextRow>
  );
}
