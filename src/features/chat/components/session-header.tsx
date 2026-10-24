// A session's controls, at the right end of the window's title bar.
//
// The session's name is in the title bar already, as the breadcrumb's last
// segment, so nothing here repeats it. There used to be a second header row
// inside the session (a sidebar toggle, a "+", the name again on a pill, the
// overview button and a menu); the title bar has its own sidebar toggle, a new
// session is ⌘N or the sidebar's button, and the rest moved up here. The row's
// height went back to the transcript.
//
// What is here:
//  - the pinned-messages pill, only while something is pinned;
//  - the ⋯ menu: search in session, the role filter, pinned messages, the Bash
//    and Plans panels, and "branch from here" where the agent can fork;
//  - the session overview button. Where the chat panel keeps room at its
//    top-right it toggles the docked card; anywhere else it opens the card
//    as a popover under itself (`session-overview-store.ts`).
//
// Rendered by `ChatPanel`, which owns all of that state, and portalled into
// the column header's slot (`session-header-slot-store.ts`).

import { lazy, memo, Suspense, useEffect, useState, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  ClipboardList,
  Ellipsis,
  GitBranch,
  ListFilter,
  PanelRight,
  Pin,
  Search,
  Sparkles,
  TerminalSquare,
  User,
} from "lucide-react";

import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { OVERVIEW_CARD_GAP } from "../lib/session-overview-layout";
import { useElementHeight } from "../lib/use-element-height";
import { pinsFor, useChatPinsStore, type ChatPin } from "../stores/chat-pins-store";
import { useSessionOverviewStore } from "../stores/session-overview-store";
import { ChatPinnedMenu } from "./chat-pinned-menu";

const SessionOverviewCard = lazy(() =>
  import("./session-overview-panel").then((m) => ({ default: m.SessionOverviewCard })),
);

export type RoleFilter = "all" | "user" | "assistant";

const ROLE_FILTERS: { value: RoleFilter; label: string; icon: typeof User }[] = [
  { value: "all", label: "All", icon: ListFilter },
  { value: "user", label: "User", icon: User },
  { value: "assistant", label: "Assistant", icon: Sparkles },
];

/** The popover's distance below its button. */
const POPOVER_OFFSET = 6;

interface SessionHeaderControlsProps {
  tabId: string;
  /** The session's overview scope (`overviewScope`). */
  overviewKey: string;
  /** Whether the chat panel has room to dock the overview card. */
  docked: boolean;
  /** The transcript's box: the popover is capped at its height, so it can
   *  never reach the composer below it. */
  stageRef: RefObject<HTMLElement | null>;
  onOpenSearch: () => void;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  /** Pin scope for this session (see `chat-pins-store`). */
  pinScopeKey: string;
  onJumpToPin: (pin: ChatPin) => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  /** Only passed when the agent advertised `sessionCapabilities.fork`, so the
   *  menu never offers a branch that would fail on the wire. */
  onForkSession?: () => void;
}

// memo: rendered by ChatPanel once per streaming rAF flush; every prop is
// identity-stable there (strings/booleans/refs + the *Stable useCallback
// wrappers), so this bails per frame and re-renders only on real changes.
export const SessionHeaderControls = memo(function SessionHeaderControls({
  tabId,
  overviewKey,
  docked,
  stageRef,
  onOpenSearch,
  roleFilter,
  onRoleFilterChange,
  pinScopeKey,
  onJumpToPin,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  onForkSession,
}: SessionHeaderControlsProps) {
  const [pinsOpen, setPinsOpen] = useState(false);
  return (
    <>
      <ChatPinnedMenu
        pinScopeKey={pinScopeKey}
        onJump={onJumpToPin}
        open={pinsOpen}
        onOpenChange={setPinsOpen}
      />
      <MoreMenu
        onOpenSearch={onOpenSearch}
        roleFilter={roleFilter}
        onRoleFilterChange={onRoleFilterChange}
        pinScopeKey={pinScopeKey}
        onOpenPins={() => setPinsOpen(true)}
        bashPanelOpen={bashPanelOpen}
        onToggleBash={onToggleBash}
        plansPanelOpen={plansPanelOpen}
        onTogglePlans={onTogglePlans}
        onForkSession={onForkSession}
      />
      {docked ? (
        <OverviewDockToggle overviewKey={overviewKey} />
      ) : (
        <OverviewPopover
          tabId={tabId}
          overviewKey={overviewKey}
          stageRef={stageRef}
          onOpenSearch={onOpenSearch}
        />
      )}
      <OverviewHandOver overviewKey={overviewKey} docked={docked} />
    </>
  );
});

/** Labels for the overview button, open and closed. */
function overviewLabel(open: boolean) {
  return open ? "Hide session overview" : "Show session overview";
}

/** A click that came from the keyboard (Enter / Space on the button). */
function fromKeyboard(event: Event | undefined | null): boolean {
  return !!event && "detail" in event && (event as MouseEvent).detail === 0;
}

/** Docked: the button shows or hides the card drawn into the panel's room. */
function OverviewDockToggle({ overviewKey }: { overviewKey: string }) {
  const open = useSessionOverviewStore((s) => !!s.open[overviewKey]);
  const { toggle } = useSessionOverviewStore.use.actions();
  const label = overviewLabel(open);
  return (
    <HintItem label={label}>
      <IconButton
        icon={PanelRight}
        label={label}
        size="sm"
        iconSize="md"
        aria-pressed={open}
        data-session-overview-toggle
        onClick={(e) => toggle(overviewKey, { instant: fromKeyboard(e.nativeEvent) })}
      />
    </HintItem>
  );
}

/** No room to dock: the card is a popover anchored under the button. */
function OverviewPopover({
  tabId,
  overviewKey,
  stageRef,
  onOpenSearch,
}: {
  tabId: string;
  overviewKey: string;
  stageRef: RefObject<HTMLElement | null>;
  onOpenSearch: () => void;
}) {
  const open = useSessionOverviewStore((s) => s.popoverFor === overviewKey);
  const instant = useSessionOverviewStore((s) => s.instant);
  const { setPopover } = useSessionOverviewStore.use.actions();
  // Measured only while open: the room under the title bar, down to the
  // composer, less the gap the card keeps from it.
  const stage = useElementHeight(stageRef, open);
  const maxHeight = stage === null ? null : Math.max(0, stage - POPOVER_OFFSET - OVERVIEW_CARD_GAP);
  const label = overviewLabel(open);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // The Session card's comments and share morphs open in a portal of
        // their own; a press inside one is not a press outside the card.
        if (!next && (details.reason === "outside-press" || details.reason === "focus-out")) {
          const target =
            details.reason === "focus-out"
              ? (details.event as FocusEvent).relatedTarget
              : details.event.target;
          if (target instanceof Element && target.closest("[data-session-overview-portal]")) {
            details.cancel();
            return;
          }
        }
        setPopover(overviewKey, next, { instant: fromKeyboard(details.event) });
      }}
    >
      <HintItem label={label}>
        <Popover.Trigger
          data-session-overview-toggle
          render={<IconButton icon={PanelRight} label={label} size="sm" iconSize="md" />}
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner
          className="z-popover"
          side="bottom"
          align="end"
          sideOffset={POPOVER_OFFSET}
          collisionPadding={OVERVIEW_CARD_GAP}
        >
          <Popover.Popup
            aria-label="Session overview"
            className={cn(
              "origin-[var(--transform-origin)] outline-none",
              // Grows out of its button, quickly; and not at all when the
              // keyboard opened it, where the card should be there on the key.
              instant ? "" : "data-open:animate-scale-in data-closed:animate-scale-out",
            )}
          >
            <Suspense fallback={null}>
              <SessionOverviewCard
                tabId={tabId}
                onOpenSearch={onOpenSearch}
                presentation="popover"
                maxHeight={maxHeight}
              />
            </Suspense>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A popover left open when the panel gains room to dock becomes the docked
 *  card, so the card the user opened stays open. */
function OverviewHandOver({ overviewKey, docked }: { overviewKey: string; docked: boolean }) {
  useEffect(() => {
    if (docked) useSessionOverviewStore.getState().actions.handOver(overviewKey);
  }, [docked, overviewKey]);
  return null;
}

function MoreMenu({
  onOpenSearch,
  roleFilter,
  onRoleFilterChange,
  pinScopeKey,
  onOpenPins,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  onForkSession,
}: {
  onOpenSearch: () => void;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  pinScopeKey: string;
  onOpenPins: () => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  onForkSession?: () => void;
}) {
  const findHint = useActionShortcut("chat.find")?.label;
  const pinCount = useChatPinsStore((s) => pinsFor(s, pinScopeKey).length);
  return (
    <DropdownMenu>
      <HintItem label="Session options">
        <DropdownMenuTrigger
          render={<IconButton icon={Ellipsis} label="Session options" size="sm" iconSize="md" />}
        />
      </HintItem>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
        <DropdownMenuItem onClick={onOpenSearch}>
          <Search />
          <span className="flex-1">Search in session</span>
          {findHint && <DropdownMenuShortcut>{findHint}</DropdownMenuShortcut>}
        </DropdownMenuItem>
        {pinCount > 0 && (
          <DropdownMenuItem onClick={onOpenPins}>
            <Pin />
            <span className="flex-1">Pinned messages</span>
            <DropdownMenuShortcut className="tabular-nums">{pinCount}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show messages from</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={roleFilter}
            onValueChange={(v) => onRoleFilterChange(v as RoleFilter)}
          >
            {ROLE_FILTERS.map(({ value, label, icon: Icon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={bashPanelOpen} onCheckedChange={onToggleBash}>
          <TerminalSquare />
          Bash calls
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={plansPanelOpen} onCheckedChange={onTogglePlans}>
          <ClipboardList />
          Plans
        </DropdownMenuCheckboxItem>

        {onForkSession && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onForkSession}>
              <GitBranch />
              <span className="flex-1">Branch from here</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
