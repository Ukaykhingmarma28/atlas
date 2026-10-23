// @vitest-environment happy-dom
//
// The Settled shelf: settled sessions leave the active list for a collapsed
// shelf at the bottom, newest settled first, a page at a time. The open
// session stays on screen even when the shelf is shut, and settling offers
// an Undo.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  calls: [] as Array<[string, unknown]>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    backend.calls.push([cmd, args]);
    if (cmd === "threads_projects") {
      return [{ name: "atlas", paths: ["/p/atlas"], isCurrent: true, threads: backend.threads }];
    }
    if (cmd === "threads_sync_project") return 0;
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionSidebar } from "./session-sidebar";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";

function thread(id: string, updatedAt: string, settledAt: string | null = null) {
  return {
    threadId: `th-${id}`,
    sessionId: `s-${id}`,
    agentId: "claude-code",
    title: `chat ${id}`,
    updatedAt,
    createdAt: null,
    archived: false,
    settledAt,
    projectName: "atlas",
    folderPaths: ["/p/atlas"],
    liveElsewhere: false,
    branch: null,
  };
}

const titlesIn = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("span.line-clamp-2"), (span) => span.textContent);
/** The active list: every title outside the shelf. */
const activeTitles = () => {
  const shelf = screen.queryByTestId("settled-shelf");
  return Array.from(screen.getByTestId("session-list").querySelectorAll("span.line-clamp-2"))
    .filter((span) => !shelf?.contains(span))
    .map((span) => span.textContent);
};

const savedSessions = useChatStore.getState().sessions;
const savedSidebar = useLayoutStore.getState().chatSidebar;

beforeEach(() => {
  backend.calls = [];
  backend.threads = [
    thread("a", "2026-10-06T10:03:00Z"),
    thread("b", "2026-10-06T10:02:00Z"),
    thread("old", "2026-09-01T10:00:00Z", "2026-09-04T10:00:00Z"),
    thread("new", "2026-09-10T10:00:00Z", "2026-09-13T10:00:00Z"),
  ];
  toast.mockClear();
  useLayoutStore.setState((s) => {
    s.chatSidebar = { ...savedSidebar, visible: true, settledExpanded: false };
  });
});
afterEach(() => {
  cleanup();
  useChatStore.setState((s) => {
    s.sessions = savedSessions;
  });
  useLayoutStore.setState((s) => {
    s.chatSidebar = savedSidebar;
  });
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionSidebar tabId="tab-1" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(activeTitles()).toEqual(["chat a", "chat b"]));
}

describe("the Settled shelf", () => {
  it("is collapsed by default, opens newest settled first, and remembers being open", async () => {
    await mount();
    const shelf = screen.getByTestId("settled-shelf");
    const toggle = within(shelf).getByRole("button", { name: /Settled/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(titlesIn(shelf)).toEqual([]);

    fireEvent.click(toggle);
    await waitFor(() => expect(titlesIn(shelf)).toEqual(["chat new", "chat old"]));
    expect(useLayoutStore.getState().chatSidebar.settledExpanded).toBe(true);
  });

  it("pages the shelf: ten, then the rest", async () => {
    backend.threads = [
      thread("a", "2026-10-06T10:03:00Z"),
      ...Array.from({ length: 12 }, (_, i) =>
        thread(`s${i}`, "2026-09-01T10:00:00Z", `2026-09-${String(10 + i)}T10:00:00Z`),
      ),
    ];
    useLayoutStore.setState((s) => {
      s.chatSidebar.settledExpanded = true;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SessionSidebar tabId="tab-1" />
      </QueryClientProvider>,
    );
    const shelf = await screen.findByTestId("settled-shelf");
    await waitFor(() => expect(titlesIn(shelf)).toHaveLength(10));
    expect(titlesIn(shelf)[0]).toBe("chat s11");
    fireEvent.click(within(shelf).getByRole("button", { name: "Show 2 more" }));
    await waitFor(() => expect(titlesIn(shelf)).toHaveLength(12));
  });

  it("keeps the open session visible while the shelf is shut", async () => {
    useChatStore.getState().actions.createSession("tab-1", "claude-code");
    useChatStore.getState().actions.setAcpBinding("tab-1", "agent-1", "s-old", "/p/atlas");
    await mount();
    expect(titlesIn(screen.getByTestId("settled-shelf"))).toEqual(["chat old"]);
  });

  it("settles from the card, with an Undo that un-settles", async () => {
    await mount();
    const card = screen.getByText("chat b").closest("[data-settled], div.group")!;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Settle session" }));
    await waitFor(() =>
      expect(backend.calls).toContainEqual(["threads_settle", { threadId: "th-b" }]),
    );
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [message, options] = toast.mock.calls[0] as [
      string,
      { duration: number; action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Session settled");
    expect(options.duration).toBe(5_000);
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() =>
      expect(backend.calls).toContainEqual(["threads_unsettle", { threadId: "th-b" }]),
    );
  });
});
