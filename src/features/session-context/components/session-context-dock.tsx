// The docked form of the session context card: an inline panel at the chat
// panel's top-right, in room the panel reserves whether or not it shows.
//
// `useContextDock` measures the panel and answers the room to reserve
// (`resolveContextDock`, from the width alone) and whether it docks at all;
// it reports `dockable` to the store, which turns the header button into a
// toggle for this tab. `DockedSessionContext` draws the card as an absolute
// layer into that room. Opening or closing it changes nothing the transcript
// or the composer is laid out from, so neither moves.

import { useEffect, useState, type RefObject } from "react";

import { projectPathForTab } from "@/features/chat/lib/tab-project";
import { HEADER_INSET } from "@/features/chat/lib/row-metrics";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { cn } from "@/lib/utils";

import { parseColumnMax, resolveContextDock, type ContextDock } from "../lib/context-dock";
import { useCaptureState } from "../lib/use-capture-state";
import { useSessionContextStore } from "../stores/session-context-store";
import { SessionContextBody } from "./session-context-popover";

const NO_DOCK: ContextDock = { docked: false, reserve: 0, inset: 0 };

/**
 * The dock for the chat panel whose conversation column is `ref`. `enabled`
 * is false while something else holds the panel's right side (the overview
 * rail): the card is the popover then, and nothing is reserved for it.
 */
export function useContextDock(
  tabId: string,
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): ContextDock {
  const [dock, setDock] = useState<ContextDock>(NO_DOCK);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === "undefined") {
      setDock(NO_DOCK);
      return;
    }
    const measure = () => {
      const columnMax = parseColumnMax(
        getComputedStyle(el).getPropertyValue("--atlas-chat-column"),
      );
      const next = resolveContextDock(el.clientWidth, columnMax);
      setDock((prev) =>
        prev.docked === next.docked && prev.reserve === next.reserve && prev.inset === next.inset
          ? prev
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);

  useEffect(() => {
    const { setDockable } = useSessionContextStore.getState().actions;
    setDockable(tabId, dock.docked);
  }, [tabId, dock.docked]);
  // A closed tab leaves no dockable flag behind to make a later button a toggle.
  useEffect(() => {
    return () => useSessionContextStore.getState().actions.setDockable(tabId, false);
  }, [tabId]);

  return dock;
}

/** The docked card, while this tab's panel docks it and it is toggled on. */
export function DockedSessionContext({ tabId, docked }: { tabId: string; docked: boolean }) {
  const open = useSessionContextStore((s) => docked && !!s.dockOpen[tabId]);
  if (!open) return null;
  return <DockedCard tabId={tabId} />;
}

function DockedCard({ tabId }: { tabId: string }) {
  // The same fallback the header button uses: the tab's project, else the
  // active one.
  const activePath = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const projectPath = projectPathForTab(tabId) ?? activePath;
  const capture = useCaptureState(projectPath);
  const view = useSessionContextStore.use.view();
  return (
    <aside
      aria-label="Session context"
      data-session-context-dock
      // Below the floating header (z-20), clear of it by the header's inset,
      // and at the card width the reservation was sized for.
      style={{ top: HEADER_INSET + 4 }}
      className={cn(
        "absolute right-3 z-10 flex max-h-[calc(100%-62px)] flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover text-foreground shadow-md animate-scale-in",
        // The capture view keeps the 352px its radar is laid out against; it
        // is a drill-in, so its extra 52px overlaps the clearance (and at
        // most a sliver of the column) for as long as it is open.
        view === "capture" ? "w-[352px]" : "w-[300px]",
      )}
    >
      <SessionContextBody tabId={tabId} projectPath={projectPath} capture={capture} />
    </aside>
  );
}
