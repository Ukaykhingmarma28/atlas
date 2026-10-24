// The chat panel's dock lane: the room at its top-right that the panel keeps
// for docked cards whether or not one shows (`context-dock.ts`).
//
// Two cards dock here, the session overview (its title-bar button) and the
// session context card (the "≡" button), stacked in that order when both are
// open. The lane is an absolute layer over the transcript area: it starts a
// gap below the title bar, ends a gap above the composer, and never takes
// layout space, so opening or closing either card moves neither the
// transcript nor the composer. A card taller than the lane shrinks and
// scrolls inside itself; the overview first sheds rows it can do without
// (`session-overview-layout.ts`).
//
// A component of its own so the open flags it reads re-render this and
// nothing else: the chat panel, and the transcript under it, never hear a
// toggle.

import { lazy, Suspense, useEffect, useRef } from "react";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { DockedSessionContext } from "@/features/session-context/components/session-context-dock";
import { cn } from "@/lib/utils";

import { OVERVIEW_CARD_GAP } from "../lib/session-overview-layout";
import { useElementHeight } from "../lib/use-element-height";
import { useSessionOverviewStore } from "../stores/session-overview-store";

const SessionOverviewCard = lazy(() =>
  import("./session-overview-panel").then((m) => ({ default: m.SessionOverviewCard })),
);

export function SessionDockLane({
  tabId,
  overviewKey,
  docked,
  onOpenSearch,
}: {
  tabId: string;
  overviewKey: string;
  /** Whether the panel keeps the room at all; nothing docks without it. */
  docked: boolean;
  onOpenSearch: () => void;
}) {
  const overviewOpen = useSessionOverviewStore((s) => docked && !!s.open[overviewKey]);
  const laneRef = useRef<HTMLDivElement>(null);
  const laneHeight = useElementHeight(laneRef, overviewOpen);
  useOverviewEscape(tabId, overviewKey, overviewOpen);

  if (!docked) return null;
  return (
    <div
      ref={laneRef}
      data-session-dock-lane
      // `pointer-events-none`: the lane is mostly empty air over the
      // transcript's gutter; only the cards in it take the pointer.
      className="pointer-events-none absolute right-3 z-panel flex flex-col items-end gap-2"
      style={{ top: OVERVIEW_CARD_GAP, bottom: OVERVIEW_CARD_GAP }}
    >
      {overviewOpen && (
        <Suspense fallback={null}>
          <DockedOverview tabId={tabId} onOpenSearch={onOpenSearch} maxHeight={laneHeight} />
        </Suspense>
      )}
      <DockedSessionContext tabId={tabId} docked={docked} />
    </div>
  );
}

function DockedOverview({
  tabId,
  onOpenSearch,
  maxHeight,
}: {
  tabId: string;
  onOpenSearch: () => void;
  maxHeight: number | null;
}) {
  // Read once, at mount: the entrance plays (or is skipped) for the toggle
  // that opened the card, not for whatever toggled last.
  const instant = useRef(useSessionOverviewStore.getState().instant).current;
  return (
    <div
      data-session-overview-dock
      className={cn(
        // Scales out of the top-right corner, under the title-bar button
        // that opened it.
        "pointer-events-auto flex min-h-0 shrink flex-col origin-top-right",
        !instant && "animate-scale-in",
      )}
    >
      <SessionOverviewCard
        tabId={tabId}
        onOpenSearch={onOpenSearch}
        presentation="docked"
        maxHeight={maxHeight}
      />
    </div>
  );
}

/**
 * Escape closes the docked card, the way it closes the popover form. Only
 * while the key is pressed inside the card, on its title-bar button, or with
 * nothing focused: an Escape in the composer belongs to the composer (its
 * menus, stopping a turn), and a card that stays open across turns must not
 * vanish because the reader dismissed something else.
 */
function useOverviewEscape(tabId: string, overviewKey: string, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Hidden sessions stay mounted; only the one on screen answers.
      if (useLayoutStore.getState().activeTabId !== tabId) return;
      const target = e.target instanceof Element ? e.target : null;
      const inCard = !!target?.closest("[data-session-overview-dock]");
      const onToggle = !!target?.closest("[data-session-overview-toggle]");
      const unfocused = !target || target === document.body;
      if (!inCard && !onToggle && !unfocused) return;
      e.preventDefault();
      useSessionOverviewStore.getState().actions.close(overviewKey);
      if (inCard) {
        // Focus would otherwise drop to <body> with the card it was in.
        document.querySelector<HTMLElement>("[data-session-overview-toggle]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId, overviewKey, open]);
}
