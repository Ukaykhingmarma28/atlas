// @vitest-environment happy-dom
// The Shared tab's Memories table: each entry shows where it came from and how
// sure the record is of it, and the user can edit or forget it from the row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedMemoryView } from "./shared-memory-view";
import { useSharedMemoryStore } from "../stores/shared-memory-store";

const EMPTY_STATE = {
  lastSeq: 0,
  activePlan: null,
  decisions: [],
  recentChanges: [],
  facts: [],
  failures: [],
  architecture: [],
  sessionAgents: {},
  updatedAt: 0,
};

function entry(id: number, content: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "failure",
    key: "",
    content,
    status: "",
    source: "extractor",
    agent: "codex",
    sessionId: "s1",
    confidence: 0.6,
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: null,
    uses: 0,
    ...over,
  };
}

let entries: ReturnType<typeof entry>[] = [];

beforeEach(() => {
  entries = [
    entry(1, "Mocking the DB hid a migration bug"),
    entry(2, "Prefers small PRs", {
      kind: "fact",
      source: "import:claude",
      agent: "",
      confidence: 0.7,
    }),
  ];
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "memory_get_state") return EMPTY_STATE;
    if (cmd === "memory_list_events") return [];
    if (cmd === "memory_list_entries") return entries;
    if (cmd === "memory_edit_entry") {
      const edited = entry(args.id as number, args.content as string, {
        source: "user",
        agent: "user",
        confidence: 1,
      });
      entries = entries.map((e) => (e.id === args.id ? edited : e));
      return edited;
    }
    if (cmd === "memory_forget_entry") {
      entries = entries.filter((e) => e.id !== args.id);
      return true;
    }
    return null;
  });
  useSharedMemoryStore.setState({ projectPath: null, loaded: false, entries: [] });
});

afterEach(cleanup);

async function openMemories() {
  const user = userEvent.setup();
  render(<SharedMemoryView projectPath="/repo" />);
  await user.click(await screen.findByRole("button", { name: /Memories/ }));
  return user;
}

describe("the Shared tab's Memories table", () => {
  it("shows each entry's source, agent and confidence", async () => {
    await openMemories();
    const extracted = (await screen.findByText("Mocking the DB hid a migration bug")).closest(
      "button",
    )!;
    expect(within(extracted).getByText("extractor")).toBeTruthy();
    expect(within(extracted).getByText("60%")).toBeTruthy();
    const imported = screen.getByText("Prefers small PRs").closest("button")!;
    expect(within(imported).getByText("import · claude")).toBeTruthy();
    expect(within(imported).getByText("70%")).toBeTruthy();
  });

  it("edits an entry in place", async () => {
    const user = await openMemories();
    await user.click(await screen.findByText("Mocking the DB hid a migration bug"));
    await user.click(screen.getByRole("button", { name: "Edit memory" }));
    const field = screen.getByRole("textbox", { name: "Memory content" });
    await user.clear(field);
    await user.type(field, "Mocks hid the migration bug");
    await user.click(screen.getByRole("button", { name: /Save/ }));

    expect(invoke).toHaveBeenCalledWith("memory_edit_entry", {
      projectPath: "/repo",
      id: 1,
      content: "Mocks hid the migration bug",
    });
    const row = (await screen.findAllByText("Mocks hid the migration bug"))[0].closest("button")!;
    // Source and agent both say the user now.
    expect(within(row).getAllByText("user")).toHaveLength(2);
    expect(within(row).getByText("100%")).toBeTruthy();
  });

  it("forgets an entry after confirming", async () => {
    const user = await openMemories();
    await user.click(await screen.findByText("Prefers small PRs"));
    await user.click(screen.getByRole("button", { name: "Forget memory" }));
    await user.click(await screen.findByRole("button", { name: "Forget" }));

    expect(invoke).toHaveBeenCalledWith("memory_forget_entry", { projectPath: "/repo", id: 2 });
    await waitFor(() => expect(screen.queryByText("Prefers small PRs")).toBeNull());
  });
});
