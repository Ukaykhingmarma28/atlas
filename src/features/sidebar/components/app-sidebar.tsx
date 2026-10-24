// The app's one left sidebar: the project picker on top (the organisation
// sits at the foot of its menu), then every session in its projects, then the
// destinations.
//
// It replaced two columns — the project rail (projects, a recent-sessions
// list, the module navigation) and the session sidebar beside each chat — so
// a session is found in one place whichever project it belongs to. Projects
// are the picker's scope and a badge on each row; the destinations are the
// footer's icons; Members is in the organisation menu (the picker's
// Organization submenu, and the title bar's breadcrumb); Agents is in
// Settings.

import { PanelLeft, PanelLeftDashed } from "lucide-react";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { DevBadge } from "@/components/titlebar";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarSessions } from "./sidebar-session-list";

export function AppSidebar() {
  const sidebarPinned = useProjectStore.use.sidebarPinned();
  const { toggleSidebarPinned } = useProjectStore.use.actions();
  const fullscreen = useFullscreen();
  return (
    <aside
      // Transparent — the surface (gradient + blur) lives on the wrapper in
      // app-layout.tsx, not here. Putting the blur on this child would break
      // it: the wrapper's opacity/transform isolates its own layer, leaving a
      // descendant's backdrop-filter nothing to sample.
      className="flex h-screen w-full shrink-0 flex-col bg-transparent"
      data-tauri-drag-region
    >
      {/* Titlebar band: on macOS the traffic lights live here, so the
       *  sidebar's own controls keep right (left in fullscreen, where the
       *  lights are gone, and on other platforms, which never have them). */}
      <div
        className={cn(
          "flex h-titlebar shrink-0 items-center gap-0.5 px-2",
          fullscreen || !isMac ? "justify-start" : "justify-end",
        )}
        data-tauri-drag-region
      >
        <DevBadge
          className={cn("mr-auto", !fullscreen && isMac && "ml-[calc(70px/var(--ui-zoom,1))]")}
        />
        {/* Docked or floating. The icon draws the layout a click switches
         *  to: a dashed panel floats over the content, a solid one takes its
         *  own column. */}
        <HintGroup>
          <HintItem label={sidebarPinned ? "Float sidebar over content" : "Dock sidebar"}>
            <button
              type="button"
              onClick={toggleSidebarPinned}
              aria-label={sidebarPinned ? "Float sidebar over content" : "Dock sidebar"}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-element-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {sidebarPinned ? (
                <PanelLeftDashed aria-hidden className="size-3.5" />
              ) : (
                <PanelLeft aria-hidden className="size-3.5" />
              )}
            </button>
          </HintItem>
        </HintGroup>
      </div>

      <SidebarSessions />
      <SidebarFooter />
    </aside>
  );
}
