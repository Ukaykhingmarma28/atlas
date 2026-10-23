import { lazy, Suspense, useEffect, useState } from "react";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { ProjectSidebar } from "@/features/projects/components/project-sidebar";
import { useProjectGitPrefetch } from "@/features/projects/lib/use-project-prefetch";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { cn } from "@/lib/utils";
import { CenterPanel } from "./center-panel";
import { DestinationScreen } from "./destination-screen";

const SettingsScreen = lazy(() =>
  import("@/features/settings/components/settings-screen").then((m) => ({
    default: m.SettingsScreen,
  })),
);

export function AppLayout() {
  // Settings covers the window once opened, and stays mounted (hidden) after,
  // so its open page and drafts survive a trip back to the workspace.
  const settingsOpen = useSettingsNav((s) => s.open);
  const [settingsMounted, setSettingsMounted] = useState(settingsOpen);
  if (settingsOpen && !settingsMounted) setSettingsMounted(true);
  const sidebarOpen = useProjectStore.use.sidebarOpen();
  const sidebarPinned = useProjectStore.use.sidebarPinned();
  const { setSidebarOpen } = useProjectStore.use.actions();
  // DOCKED = pinned + open → an in-flow left column that pushes the layout.
  // Otherwise the sidebar is an OVERLAY (rail + scrim), gated by `sidebarOpen`.
  const docked = sidebarPinned && sidebarOpen;

  // Warm the project-pane git data at startup so the first slide is smooth.
  useProjectGitPrefetch();

  // Esc closes the OVERLAY project panel (same animated slide-out as a
  // scrim click). Only active while the overlay is open — when docked or
  // closed the listener no-ops, so it never swallows Esc from other surfaces.
  const overlayOpen = sidebarOpen && !sidebarPinned;
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlayOpen, setSidebarOpen]);

  const isLinux =
    typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("linux");

  return (
    // `relative` so the project rail + scrim can be absolutely-positioned
    // OVERLAYS. The main column below is the only in-flow child, so it always
    // fills the window and NEVER reflows when the rail toggles.
    <div className="relative flex h-screen w-screen max-w-full overflow-hidden">
      {/* DOCKED project sidebar — an in-flow left column (solid, not glass)
          that pushes the whole shell right. Full-height so it sits beside the
          titlebar; the sidebar's own top bar already dodges the traffic lights.
          Only present when pinned + open; unpinned falls through to the overlay
          below. */}
      {docked && (
        // The divider's colour is `--atlas-rail-divider`, set on the rail's
        // own class in `globals.css` — see the note there. This is the one
        // edge in the shell with nothing either side of it to read against:
        // the rail sits at `--sidebar` and the content at `--background`,
        // which on an AMOLED theme are ten and zero. The hairline tokens meant
        // to separate a card from the surface it sits on disappear here.
        <div className="atlas-project-rail h-screen w-[244px] shrink-0 border-r">
          <ProjectSidebar />
        </div>
      )}

      {/*
       * NOT keyed by project: keying forced a full unmount/remount of the
       * whole shell on every switch (rebuilding CodeMirror/xterm/virtualizer)
       * — the dominant switch cost. Instead, `switchTo` swaps Zustand state in
       * place from an in-RAM snapshot (see project-snapshot.ts), so the shell
       * stays mounted and switching is near-instant.
       */}
      {/* `min-w-0` is load-bearing, not decoration. This column is a flex item
          of the row above, so without it its automatic minimum size is its
          MIN-CONTENT width — and min-content propagates up from the deepest
          `whitespace-nowrap` text in any panel (e.g. a 400-char commit subject
          in the git History list). The column then grows PAST the window,
          the split columns' `Group` resolves `width: 100%` against that
          inflated width, and every column scales with it until the last is
          pushed off-screen entirely. `overflow: hidden` on the panels
          does NOT prevent this — it stops a panel's USED size being overridden
          by its content, but the content still contributes to the group's
          intrinsic width. Capping the column here is what keeps the shell
          inside the window no matter what any panel renders. */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        {/* No top bar row: each column's header is its slice of the bar (see
            `columnChrome`). `relative` for the destination, which covers the
            columns while the session runs underneath (ADR-0024). */}
        <div className="relative flex-1 min-h-0">
          <CenterPanel />
          <DestinationScreen />
        </div>
      </div>

      {/* OVERLAY mode only (unpinned). When docked, the sidebar is the in-flow
          column above and there is no scrim/rail. */}
      {!sidebarPinned && (
        <>
          {/* Scrim — subtle dim + click-to-close (the frosted rail carries the
          depth, same as the notification overlay). Only interactive while open;
          fades via `opacity` (compositor-only, no layout). */}
          <div
            className={cn(
              // Strong dim + blur so the (possibly lagging) main content is HIDDEN
              // while the switcher is open and during its enter/exit — the animation
              // reads as a clean focus transition rather than exposing a mid-load
              // centre. Both are compositor-cheap once established.
              "absolute inset-0 z-drawer scrim-soft backdrop-blur-md transition-opacity ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              // Closing is 50% slower than opening (300 → 450ms).
              sidebarOpen
                ? "opacity-100 duration-300"
                : "opacity-0 pointer-events-none duration-[450ms]",
            )}
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />

          {/* Project rail — an OVERLAY (Linear-style), toggled by Cmd+⇧. Always
          mounted; it sits ABOVE the content (never in flow), so toggling it does
          zero layout work on the shell — the content underneath stays perfectly
          still. It SLIDES (GPU `translateX`) AND FADES (`opacity`) together for a
          smooth reveal.

          The frosted glass (`bg .../60 backdrop-blur-2xl`) lives on THIS element
          — the same one that carries the transform/opacity — exactly like the
          notification overlay. Critical: `backdrop-filter` breaks if an ANCESTOR
          is an isolated compositing layer (opacity<1 / will-change / transform),
          so the blur must NOT sit on a child of the animated wrapper, and we do
          NOT set `will-change` here (it would isolate the layer and flatten the
          backdrop to nothing — the panel would look merely transparent). Closed =
          parked off the left edge, transparent. */}
          <div
            className={cn(
              "absolute left-0 top-0 h-screen w-[244px] z-drawer border-r backdrop-blur-2xl transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none [backface-visibility:hidden]",
              // Closing (slide-out) is 50% slower than opening (300 → 450ms).
              sidebarOpen ? "duration-300" : "duration-[450ms]",
              // The gradient rail. Linux gets the opaque variant — no
              // compositor blur to sit on there.
              isLinux ? "atlas-project-rail" : "atlas-project-rail--glass",
            )}
            style={{
              transform: sidebarOpen ? "translateX(0)" : "translateX(-244px)",
              opacity: sidebarOpen ? 1 : 0,
            }}
            aria-hidden={!sidebarOpen}
          >
            <ProjectSidebar />
          </div>
        </>
      )}
      {settingsMounted && (
        <Suspense fallback={null}>
          <SettingsScreen />
        </Suspense>
      )}
    </div>
  );
}
