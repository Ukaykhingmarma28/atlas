// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  TEAM_CHAT_TAB,
  groupOf,
  persistsInEditorState,
  restoredTabType,
  useLayoutStore,
  type ProjectView,
  type Tab,
} from "./layout-store";
import { revealTeamChat, teamChatShown, toggleTeamChat } from "../lib/team-chat";

/**
 * Team chat is a surface tab that belongs to the window, not a project
 * (`WINDOW_TYPES`): it follows the user between projects, one per window, and
 * whether it was open is a layout preference rather than project state.
 */

const layout = () => useLayoutStore.getState();
const actions = () => layout().actions;

const tab = (id: string, type: Tab["type"], groupId: string): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data: {},
  groupId,
});

const view = (tabs: Tab[], groupOrder: string[], active: Record<string, string>): ProjectView => ({
  tabs,
  activeTabId: active[groupOrder[0]],
  groupOrder,
  activeByGroup: active,
  focusedGroupId: groupOrder[0],
  tabHistory: [],
  tabHistoryIndex: 0,
});

beforeEach(() => {
  useLayoutStore.setState({
    tabs: [tab("chat-a", "chat", "main")],
    groupOrder: ["main"],
    activeByGroup: { main: "chat-a" },
    focusedGroupId: "main",
    activeTabId: "chat-a",
    surfaces: "shown",
    zen: false,
    zenPrev: null,
    destination: null,
    destinationShown: false,
    viewsByWs: {
      b: view([tab("chat-b", "chat", "main"), tab("term-b", "terminal", "b2")], ["main", "b2"], {
        main: "chat-b",
        b2: "term-b",
      }),
      c: view([tab("chat-c", "chat", "main")], ["main"], { main: "chat-c" }),
    },
  });
});

describe("team chat follows the window", () => {
  it("opens beside the session, never over it", () => {
    revealTeamChat();
    const chat = layout().tabs.find((t) => t.type === "team-chat")!;
    expect(groupOf(chat)).not.toBe(layout().groupOrder[0]);
    expect(teamChatShown(layout())).toBe(true);
  });

  it("is one per window: asking for it in another column focuses the open one", () => {
    revealTeamChat();
    actions().addGroup();
    const other = layout().groupOrder[2];
    actions().addTab({ ...TEAM_CHAT_TAB }, other);
    expect(layout().tabs.filter((t) => t.type === "team-chat")).toHaveLength(1);
  });

  it("comes along to the next project, in the same column position, still showing", () => {
    revealTeamChat();
    actions().commitProjectView("a");
    actions().loadProjectView("b");
    const chat = layout().tabs.find((t) => t.type === "team-chat")!;
    expect(groupOf(chat)).toBe("b2");
    expect(layout().activeByGroup.b2).toBe(chat.id);
    expect(layout().tabs.some((t) => t.id === "term-b")).toBe(true);
  });

  it("opens a surfaces column in a project that has none", () => {
    revealTeamChat();
    actions().loadProjectView("c");
    expect(layout().groupOrder.length).toBe(2);
    expect(teamChatShown(layout())).toBe(true);
  });

  it("stays closed in a project left with it open, once it was closed elsewhere", () => {
    revealTeamChat();
    actions().commitProjectView("a");
    actions().loadProjectView("b");
    toggleTeamChat();
    expect(layout().tabs.some((t) => t.type === "team-chat")).toBe(false);
    actions().commitProjectView("b");
    actions().loadProjectView("a");
    expect(layout().tabs.some((t) => t.type === "team-chat")).toBe(false);
  });

  it("is never written to, or restored from, a project's editor state", () => {
    expect(persistsInEditorState({ type: "team-chat", closable: true })).toBe(false);
    expect(restoredTabType("team-chat")).toBeNull();
  });

  it("reopens on launch when it was open, including a save from the right-slot days", () => {
    const merge = useLayoutStore.persist.getOptions().merge!;
    const fresh = { ...layout(), tabs: [tab("welcome-chat", "chat", "main")] };
    const has = (state: unknown) =>
      (state as { tabs: Tab[] }).tabs.some((t) => t.type === "team-chat");
    expect(has(merge({ teamChat: { open: true } }, fresh))).toBe(true);
    expect(has(merge({ teamChat: { open: false } }, fresh))).toBe(false);
    expect(has(merge({ rightPanel: { visible: true, width: 300 } }, fresh))).toBe(true);
    expect(has(merge({ rightPanel: { visible: true, mode: "chat" } }, fresh))).toBe(true);
    expect(has(merge({ rightPanel: { visible: true, mode: "git" } }, fresh))).toBe(false);
  });
});
