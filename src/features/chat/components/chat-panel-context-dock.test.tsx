// @vitest-environment happy-dom
//
// The session context card docks beside the transcript on a wide panel, and
// showing or hiding it must not move the transcript column or the composer.
// The room is reserved from the panel's width, open or closed, and the card is
// an absolute layer drawn into it. This renders the real panel and compares
// every box the column is laid out from — the row it is centred in, the column
// itself, the composer stack — with the card closed, open, and closed again.
//
// The panel's children are stubbed: what is under test is the frame.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  const agents = new Proxy({}, { get: () => vi.fn(async () => ({})) });
  return { ...real, agents, ensureAgent: vi.fn(async () => ({})), resetAgent: vi.fn() };
});
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./chat-header", () => ({ ChatHeader: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./chat-comments-controller", () => ({ ChatCommentsController: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
vi.mock("./transcript", () => ({ Transcript: Null }));
vi.mock("./thread-overview-panel", () => ({ ThreadOverviewPanel: Null }));
vi.mock("@/features/session-context/components/session-context-popover", () => ({
  SessionContextBody: Null,
}));

import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resolveContextDock } from "@/features/session-context/lib/context-dock";
import { useSessionContextStore } from "@/features/session-context/stores/session-context-store";
import { useChatStore } from "../stores/chat-store";
import { overviewScope, useThreadOverviewStore } from "../stores/thread-overview-store";
import { ChatPanel } from "./chat-panel";

const TAB = "tab-1";
const WIDTH = 1000;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // happy-dom lays nothing out: give the conversation column a width.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-chat-drop-zone") ? WIDTH : 0;
    },
  );
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useChatStore.setState((s) => {
    s.sessions[TAB].messages = [
      { id: "m1", role: "user", content: "hi", timestamp: 0 },
    ] as unknown as (typeof s.sessions)[typeof TAB]["messages"];
  });
  useThreadOverviewStore.setState({ open: {}, width: 300 });
  useSessionContextStore.setState({ openFor: null, dockable: {}, dockOpen: {}, view: "main" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} />
    </QueryClientProvider>,
  );
}

/** Every box the transcript column's position and width come from. */
function frame(root: HTMLElement) {
  const box = (sel: string) => {
    const el = root.querySelector<HTMLElement>(sel);
    expect(el, sel).not.toBeNull();
    return { style: el!.getAttribute("style"), className: el!.className };
  };
  return {
    row: box("[data-chat-row]"),
    column: box("[data-chat-column]"),
    composer: box("[data-chat-composer-stack]"),
  };
}

const card = (root: HTMLElement) => root.querySelector("[data-session-context-dock]");

describe("the docked session context card in the chat panel", () => {
  it("never moves the transcript column or the composer when toggled", () => {
    const { container } = mount();
    const { reserve } = resolveContextDock(WIDTH, Number.POSITIVE_INFINITY);
    expect(reserve).toBeGreaterThan(0);
    expect(useSessionContextStore.getState().dockable[TAB]).toBe(true);

    const closed = frame(container);
    // Reserved while closed: the room exists before the card does.
    expect(closed.row.style).toContain(`padding-right: ${reserve}px`);
    expect(closed.composer.style).toContain(`margin-right: ${reserve}px`);
    expect(card(container)).toBeNull();

    act(() => useSessionContextStore.getState().actions.toggle(TAB));
    expect(card(container)).not.toBeNull();
    expect(frame(container)).toEqual(closed);

    act(() => useSessionContextStore.getState().actions.toggle(TAB));
    expect(card(container)).toBeNull();
    expect(frame(container)).toEqual(closed);
  });

  it("gives the right side to the overview rail: no dock, no reservation", () => {
    useThreadOverviewStore.setState({
      open: { [overviewScope(TAB, undefined)]: true },
      width: 300,
    });
    const { container } = mount();
    expect(useSessionContextStore.getState().dockable[TAB]).toBeUndefined();
    expect(frame(container).row.style).toBeNull();
  });
});
