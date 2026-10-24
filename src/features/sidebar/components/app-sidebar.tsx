// The app's one left sidebar: the organisation on top, then every session in
// its projects, then the destinations.
//
// It replaced two columns — the project rail (projects, a recent-sessions
// list, the module navigation) and the session sidebar beside each chat — so
// a session is found in one place whichever project it belongs to. Projects
// are a filter and a badge on each row; the destinations are the footer's
// icons; Members is in the organisation menu; Agents is in Settings.

import { Pin, PinOff } from "lucide-react";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { DevBadge } from "@/components/titlebar";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { OrgSwitcher } from "@/features/organisations/components/org-switcher";
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
        <HintGroup>
          <HintItem
            label={
              sidebarPinned ? "Unpin sidebar (float as overlay)" : "Pin sidebar (dock into layout)"
            }
          >
            <button
              type="button"
              onClick={toggleSidebarPinned}
              className={cn(
                "flex size-6 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-element-hover",
                sidebarPinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {sidebarPinned ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
          </HintItem>
        </HintGroup>
      </div>

      {/* Organisation switcher — the top-level tenant picker. */}
      <OrgSwitcher />

      <SidebarSessions />
      <SidebarFooter />
    </aside>
  );
}
