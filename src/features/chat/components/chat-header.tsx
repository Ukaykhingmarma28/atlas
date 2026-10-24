// The chat header.
//
// Deliberately minimal: a session name with a chevron on the left,
// and everything else folded behind icon buttons. The previous header put a
// 280px search field, a role-filter pill, and three named toggles (Bash /
// Plans / Zen) permanently on screen — five controls competing with the
// transcript, most of them rarely used.
//
// Every control in the bar is CONTROL_H tall and shares one outline treatment,
// so the row lines up on a single optical baseline. That is the whole design:
// one height, one border.
//
// There is no session picker here: every session is in the app sidebar. The
// title opens it with its search focused, and the left button shows or hides
// it.

import { forwardRef, memo, useState } from "react";
import { MenuGlyph } from "@/ui/animated-icon";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  GitBranch,
  TerminalSquare,
  ClipboardList,
  ListFilter,
  PanelRight,
  PanelLeft,
  User,
  Sparkles,
  Check,
  Plus,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { ChatPinnedMenu } from "./chat-pinned-menu";
import type { ChatPin } from "../stores/chat-pins-store";

export type RoleFilter = "all" | "user" | "assistant";

/**
 * One height for every control in the bar.
 *
 * Alignment here is not a matter of `items-center` — that centres boxes of
 * different heights, which still reads as ragged because the borders don't line
 * up. The pill and the circles have to be the SAME box.
 */
const CONTROL_H = "h-[26px]";

/**
 * The single control treatment, shared by the pill and all three circles.
 *
 * A faint fill carries the shape and the border only needs to finish the edge —
 * so the border is deliberately softer than it was when it was doing the job
 * alone (the previous solid-grey border was roughly 23% white; this is ~16%).
 * Outline-only controls on a near black header read as wireframes;
 * fill-plus-whisper reads as a surface.
 *
 * Foreground-tinted rather than white alphas, so the controls track the active
 * theme (a light appearance gets a dark outline, not an invisible white one)
 * and still sit correctly on the translucent blurred band behind them. The
 * border is mixed here rather than taken from `--border` / `--atlas-border-strong`:
 * those are opaque greys tuned for panel edges, dimmer than 16% at rest and a
 * much bigger jump than 22% on hover.
 */
const OUTLINE = [
  "border border-[color-mix(in_srgb,var(--foreground)_16%,transparent)] bg-[var(--atlas-element-hover)] text-[var(--muted-foreground)]",
  "transition-colors hover:border-[color-mix(in_srgb,var(--foreground)_22%,transparent)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)]",
].join(" ");

interface ChatHeaderProps {
  /** The session's name, on the title pill. */
  title: string;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  /** Pin scope for this thread (see `chat-pins-store`). The pin count control
   *  renders itself away when the thread has no pins. */
  pinScopeKey: string;
  onJumpToPin: (pin: ChatPin) => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  /** The thread overview rail — subagents, changes, memories. */
  overviewOpen: boolean;
  onToggleOverview: () => void;
  /** The app sidebar, where the sessions are. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Open the app sidebar with its session search focused. */
  onFindSession: () => void;
  /** P3.4: only rendered when the agent advertised `sessionCapabilities.fork`.
   *  Absent for every agent that did not, so the menu never offers a branch
   *  that would fail on the wire. */
  onForkSession?: () => void;
  onNewSession: () => void;
}

// memo: rendered by ChatPanel once per streaming rAF flush; every prop is
// identity-stable there (strings/booleans + the *Stable useCallback wrappers),
// so this bails per frame and re-renders only on real header state changes.
export const ChatHeader = memo(ChatHeaderImpl);

function ChatHeaderImpl({
  title,
  roleFilter,
  onRoleFilterChange,
  pinScopeKey,
  onJumpToPin,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  overviewOpen,
  onToggleOverview,
  sidebarOpen,
  onToggleSidebar,
  onFindSession,
  onForkSession,
  onNewSession,
}: ChatHeaderProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    // No border and NO BACKGROUND. The bar floats over the transcript (see the
    // absolute wrapper in ChatPanel) and the transcript draws a progressive blur
    // band behind it, so the thread stays visible-but-blurred underneath. Giving
    // this element a fill would hide the very effect it sits on.
    <div className="relative shrink-0">
      <HintGroup>
        <div className="flex h-[46px] items-center gap-2 px-6">
          {/* The app sidebar, on the side it opens — the mirror of the
              overview button at the other end of the bar. */}
          <HeaderCircleButton
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            onClick={onToggleSidebar}
            aria-pressed={sidebarOpen}
            className={cn(
              sidebarOpen && "bg-[var(--atlas-element-active)] text-[var(--foreground)]",
            )}
          >
            <PanelLeft size={13} />
          </HeaderCircleButton>

          <HeaderCircleButton title="New session" onClick={onNewSession}>
            <Plus size={13} />
          </HeaderCircleButton>

          {/* The session's name. Sessions are found in the app sidebar, so
              the pill opens it with its search focused, rather than a second
              copy of the list. */}
          <button
            type="button"
            onClick={onFindSession}
            className={cn(
              "flex min-w-0 max-w-[46%] items-center gap-1.5 rounded-full px-3",
              CONTROL_H,
              OUTLINE,
              "text-sm font-medium leading-none text-[var(--foreground)]",
              "cursor-pointer outline-none",
            )}
            title="Find a session"
          >
            <span className="truncate">{title}</span>
            <Search size={12} className="shrink-0 text-[var(--muted-foreground)]" />
          </button>

          <div className="flex-1" />

          {/* Left of Find, so the two "go back to something" controls sit
            together at the right end of the bar. Pill-shaped rather than a
            circle because it carries a count. */}
          <ChatPinnedMenu
            pinScopeKey={pinScopeKey}
            onJump={onJumpToPin}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-2.5",
              CONTROL_H,
              OUTLINE,
              "cursor-pointer outline-none",
            )}
          />

          <HeaderCircleButton
            title={overviewOpen ? "Close overview" : "Thread overview"}
            onClick={onToggleOverview}
            aria-pressed={overviewOpen}
            className={cn(
              overviewOpen && "bg-[var(--atlas-element-active)] text-[var(--foreground)]",
            )}
          >
            <PanelRight size={13} />
          </HeaderCircleButton>

          {/* `onOpenChange` on an otherwise uncontrolled Root: the glyph needs
              to know the menu is open, but nothing else here does, so lifting
              the open state outright would buy a re-render for no reason. */}
          <DropdownMenu.Root onOpenChange={setMoreOpen}>
            <DropdownMenu.Trigger
              render={
                <HeaderCircleButton title="More">
                  <MenuGlyph active={moreOpen} size="md" />
                </HeaderCircleButton>
              }
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={6}>
                <DropdownMenu.Popup className="min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-md">
                  <MenuLabel>Filter messages</MenuLabel>
                  {(["all", "user", "assistant"] as const).map((f) => (
                    <DropdownMenu.Item
                      key={f}
                      onClick={() => onRoleFilterChange(f)}
                      className={cn(
                        "flex h-[26px] cursor-default items-center gap-2 px-3 text-xs capitalize outline-none",
                        roleFilter === f
                          ? "bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
                          : "text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
                      )}
                    >
                      {f === "user" ? (
                        <User size={11} />
                      ) : f === "assistant" ? (
                        <Sparkles size={11} />
                      ) : (
                        <ListFilter size={11} />
                      )}
                      <span className="flex-1">{f}</span>
                      {roleFilter === f && <Check size={11} />}
                    </DropdownMenu.Item>
                  ))}

                  <DropdownMenu.Separator className="my-1 h-px bg-[var(--atlas-border-subtle)]" />

                  <DropdownMenu.Item
                    onClick={onToggleBash}
                    className="flex h-[26px] cursor-default items-center gap-2 px-3 text-xs text-[var(--secondary-foreground)] outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                  >
                    <TerminalSquare size={11} />
                    <span className="flex-1">Bash calls</span>
                    {bashPanelOpen && <Check size={11} />}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={onTogglePlans}
                    className="flex h-[26px] cursor-default items-center gap-2 px-3 text-xs text-[var(--secondary-foreground)] outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                  >
                    <ClipboardList size={11} />
                    <span className="flex-1">Plans</span>
                    {plansPanelOpen && <Check size={11} />}
                  </DropdownMenu.Item>
                  {onForkSession && (
                    <>
                      <DropdownMenu.Separator className="my-1 h-px bg-[var(--atlas-border-subtle)]" />
                      <DropdownMenu.Item
                        onClick={onForkSession}
                        className="flex h-[26px] cursor-default items-center gap-2 px-3 text-xs text-[var(--secondary-foreground)] outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                      >
                        <GitBranch size={11} />
                        <span className="flex-1">Branch from here</span>
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.Popup>
              </DropdownMenu.Positioner>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </HintGroup>

      {/* No fade element here: the blur behind this bar is drawn by the
          transcript's top `GradualBlur`. A backdrop-filter can only blur what is
          painted behind it, so it has to live in the scroller's stacking
          context — not in a header that owns its own row. */}
    </div>
  );
}

/**
 * A round icon button: thin border, flat fill. That is the whole treatment.
 *
 * It briefly carried a gradient hairline across the top, borrowed from a wide
 * `px-10` pill where the top edge is a long straight run. A circle this small
 * has no straight top edge at all, so the line overshot the arc at both ends and
 * read as a bar floating above the button rather than as light on its rim. The
 * effect does not survive the shape; it was removed rather than tuned.
 *
 * `forwardRef` is required: a trigger's `render` clones this element and hands
 * it a ref, and without one the dropdown has nothing to anchor to.
 */
const HeaderCircleButton = forwardRef<
  HTMLButtonElement,
  {
    children: React.ReactNode;
    title: string;
    onClick?: () => void;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function HeaderCircleButton({ children, title, onClick, className, ...rest }, ref) {
  return (
    <HintItem label={title}>
      <button
        {...rest}
        ref={ref}
        type="button"
        onClick={onClick}
        className={cn(
          "grid w-[26px] shrink-0 place-items-center rounded-full",
          CONTROL_H,
          OUTLINE,
          "cursor-pointer outline-none",
          className,
        )}
      >
        {children}
      </button>
    </HintItem>
  );
});

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-1.5 text-3xs uppercase tracking-wider text-[var(--muted-foreground)]">
      {children}
    </div>
  );
}
