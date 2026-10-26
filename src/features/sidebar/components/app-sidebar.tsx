// The app's one left sidebar, at two widths, one shape. It is a card under
// the titlebar band in both: closed, a rail of icons that never leaves the
// window; open, the same card widened, the icons labelled and the sessions
// under them. The project picker heads it (the organisation sits at the foot
// of its menu), then the destinations, and the notification bell is last.
//
// One shape because the open/closed change should read as the card growing,
// nothing else. The band above stays the window's background, continuous
// with the column header beside it, so the traffic lights — wider than the
// rail — never have a divider running up through them, and the card's top
// edge and corner do not move when it opens. The icons keep their place too:
// same box, same x, same y; opening adds words and the session list.
//
// It replaced two columns — the project rail (projects, a recent-sessions
// list, the module navigation) and the session sidebar beside each chat — so
// a session is found in one place whichever project it belongs to. Projects
// are the picker's scope and a badge on each row; Members is in the
// organisation menu (the picker's Organization submenu, and the title bar's
// breadcrumb); Agents is in Settings.
//
// Opening and closing do not animate: the toggle is a shortcut pressed many
// times a day.

import { DevBadge } from "@/components/titlebar";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  KnowledgeButton,
  MemoryButton,
  NotificationsButton,
  RailExpandedContext,
  SourceControlButton,
  TeamChatButton,
  TimelineButton,
  UsageButton,
} from "./sidebar-destinations";
import { SidebarProjectPicker } from "./project-picker";
import { SidebarSessions } from "./sidebar-session-list";

export function AppSidebar({ expanded }: { expanded: boolean }) {
  const fullscreen = useFullscreen();
  return (
    <RailExpandedContext.Provider value={expanded}>
      <aside
        // Transparent — the rail's surface (`atlas-project-rail`) lives on the
        // wrapper in app-layout.tsx.
        className="flex h-screen w-full shrink-0 flex-col bg-transparent"
        data-tauri-drag-region
      >
        {/* Titlebar band: on macOS the traffic lights live here. Open, the
         *  dev badge clears them (it sits left in fullscreen, where the lights
         *  are gone, and on other platforms, which never have them); closed,
         *  the rail is narrower than the lights and the column header beside
         *  it carries the badge. */}
        <div
          className={cn(
            "flex h-titlebar shrink-0 items-center gap-0.5 px-2",
            fullscreen || !isMac ? "justify-start" : "justify-end",
          )}
          data-tauri-drag-region
        >
          {expanded && (
            <DevBadge
              className={cn("mr-auto", !fullscreen && isMac && "ml-[calc(70px/var(--ui-zoom,1))]")}
            />
          )}
        </div>

        <div
          className="atlas-project-rail flex min-h-0 flex-1 flex-col rounded-tr-lg border-r border-t pt-2"
          data-tauri-drag-region
        >
          <div className="px-[8px]">
            <SidebarProjectPicker compact={!expanded} />
          </div>
          <div className="mb-2 mt-1">
            <Destinations />
          </div>
          {expanded ? <SidebarSessions /> : <div className="flex-1" data-tauri-drag-region />}
          <RailFoot expanded={expanded} />
        </div>
      </aside>
    </RailExpandedContext.Provider>
  );
}

/** The destinations, top to bottom: the global views, then the open
 *  project's. */
function Destinations() {
  return (
    <nav aria-label="Destinations" className="flex shrink-0 flex-col items-start gap-0.5 px-[8px]">
      <TeamChatButton />
      <TimelineButton />
      <MemoryButton />
      <UsageButton />
      <span aria-hidden className="mx-1.5 my-1 h-px self-stretch bg-border-subtle" />
      {/* The project's own views: greyed, saying why, with none open. */}
      <KnowledgeButton />
      <SourceControlButton />
    </nav>
  );
}

/** The rail's last item, the notification bell. Open, a short fade from the
 *  rail's colour separates the scrolling session list from it. */
function RailFoot({ expanded }: { expanded: boolean }) {
  return (
    <div
      className={cn(
        "relative flex shrink-0 flex-col items-start px-[8px] pb-2 pt-1",
        expanded &&
          "before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-gradient-to-t before:from-sidebar before:to-transparent",
      )}
    >
      <NotificationsButton />
    </div>
  );
}
