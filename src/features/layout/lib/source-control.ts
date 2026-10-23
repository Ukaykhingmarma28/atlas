import {
  groupOf,
  useLayoutStore,
  type SourceControlSection,
  type Tab,
} from "../stores/layout-store";

/**
 * Source control is a surface: a singleton tab that opens in the surfaces
 * pane beside the agent, like every other surface. It used to
 * be the right slot's occupant, swapping with team chat; the slot is chat's
 * alone now.
 */

const TAB: Tab = {
  id: "source-control",
  type: "source-control",
  title: "Source control",
  closable: true,
  dirty: false,
  data: {},
};

/** The open source-control tab, if any. */
function sourceControlTab(): Tab | undefined {
  return useLayoutStore.getState().tabs.find((t) => t.type === "source-control");
}

/**
 * Whether source control is on screen: the active tab of a column that is
 * showing. Selector-shaped so a component can subscribe to it.
 */
export function sourceControlShown(s: ReturnType<typeof useLayoutStore.getState>): boolean {
  const tab = s.tabs.find((t) => t.type === "source-control");
  if (!tab) return false;
  const group = groupOf(tab);
  if (s.activeByGroup[group] !== tab.id) return false;
  const isMain = group === s.groupOrder[0];
  return isMain ? s.surfaces !== "expanded" : s.surfaces !== "hidden";
}

/**
 * Bring source control on screen, on `section` when given: focus the tab where
 * it already is, else open it in the surfaces pane (growing one beside the
 * main column when the window has only that).
 */
export function revealSourceControl(section?: SourceControlSection): void {
  const { actions } = useLayoutStore.getState();
  if (section) actions.setSourceControlSection(section);
  const existing = sourceControlTab();
  if (existing) {
    actions.setActiveTab(existing.id);
    return;
  }
  const { groupOrder } = useLayoutStore.getState();
  if (groupOrder.length === 1) {
    actions.setFocusedGroup(groupOrder[0]);
    actions.addGroup();
  }
  const { groupOrder: order, focusedGroupId } = useLayoutStore.getState();
  // Never the main column: a surface opens beside the agent, not over it.
  const target = focusedGroupId === order[0] ? order[1] : focusedGroupId;
  actions.addTab(TAB, target ?? order[0]);
}

/** ⌘⇧B: close source control when it is on screen, else reveal it. */
export function toggleSourceControl(): void {
  const state = useLayoutStore.getState();
  const tab = sourceControlTab();
  if (tab && sourceControlShown(state)) state.actions.closeTab(tab.id);
  else revealSourceControl();
}
