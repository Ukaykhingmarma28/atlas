import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "../stores/layout-store";

/**
 * Which side columns are on screen, and so which column's header sits at each
 * end of the window's bar.
 *
 * There is no full-width titlebar: each column draws its own `PaneHeader`, and
 * the window-level controls go in the outermost ones — the leading cluster
 * (traffic lights, project and left-panel toggles, `org / project`) in the
 * leftmost header, the trailing dock in the rightmost. The left panel is
 * leftmost whenever it shows; otherwise the first split column is. The right
 * panel is rightmost whenever it shows; otherwise the last split column is.
 *
 * `AppLayout` reads the same two booleans to decide what to mount, so a header
 * can never claim an edge that a panel it cannot see is occupying.
 */
export function useShellEdges(): { leftPanelShown: boolean; rightPanelShown: boolean } {
  const hasProject = useAppStore((s) => !!s.currentProject);
  const leftVisible = useLayoutStore((s) => s.leftPanel.visible);
  // Team chat is org-scoped, so the slot shows with no project open too.
  const rightShown = useLayoutStore((s) => s.rightPanel.visible);
  return { leftPanelShown: leftVisible && hasProject, rightPanelShown: rightShown };
}

/**
 * What one split column's header carries, given where the column sits: the
 * outermost column headers host the window's leading and trailing controls.
 */
export function useColumnChrome(
  atLeft: boolean,
  atRight: boolean,
): { leading: boolean; breadcrumb: boolean; trailing: boolean } {
  const { leftPanelShown, rightPanelShown } = useShellEdges();
  return {
    leading: atLeft && !leftPanelShown,
    // The first column always heads with `org / project` — inside the leading
    // cluster when it has one, alone when the file tree has it.
    breadcrumb: atLeft,
    trailing: atRight && !rightPanelShown,
  };
}
