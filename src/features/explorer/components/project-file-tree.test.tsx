// @vitest-environment happy-dom
/**
 * The tree's search field: typing never waits on the index. One pause asks
 * once, for that project, and Escape gives the tree back.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../hooks/use-external-file-drop", () => ({
  useExternalFileDrop: () => ({ externalDropPath: null }),
}));
vi.mock("@/features/git/lib/use-working-tree-changes", () => ({
  useWorkingTreeChanges: () => ({ files: new Map(), dirs: new Map() }),
}));

import { useProjectStore } from "@/features/projects/stores/project-store";
import { dropProjectTreeModel } from "../lib/project-tree-model";
import { SEARCH_DEBOUNCE_MS } from "../lib/tree-search";
import { ProjectFileTree } from "./project-file-tree";

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_directories") {
      return (args.paths as string[]).map((path) => ({
        path,
        entries: path === "" ? [{ path: "src", kind: "directory" }] : [],
      }));
    }
    if (cmd === "fileindex_search") return [{ path: "/p/src/main.ts", rel: "src/main.ts" }];
    if (cmd === "fileindex_open_project") return 1;
    return null;
  });
  useProjectStore.setState({
    projects: [
      { id: "w-1", name: "atlas", path: "/p" },
      { id: "w-2", name: "other", path: "/q" },
    ] as never,
    activeProjectId: "w-2",
  });
});
afterEach(() => {
  cleanup();
  dropProjectTreeModel("/p");
  vi.useRealTimers();
});

const searches = () => invoke.mock.calls.filter(([cmd]) => cmd === "fileindex_search");

describe("tree search", () => {
  it("asks the index once per pause, for the tree's own project", async () => {
    render(<ProjectFileTree root="/p" activeFile={null} />);
    const field = screen.getByPlaceholderText("Search files");
    for (const value of ["m", "ma", "mai", "main"]) {
      fireEvent.change(field, { target: { value } });
      await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS / 2));
    }
    expect(searches()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searches()).toHaveLength(1);
    // The tree's project, not the active one.
    expect(searches()[0][1]).toMatchObject({ query: "main", workspaceId: "w-1" });
  });

  it("clears and gives the tree back on Escape", async () => {
    render(<ProjectFileTree root="/p" activeFile={null} />);
    const field = screen.getByPlaceholderText<HTMLInputElement>("Search files");
    fireEvent.change(field, { target: { value: "zzz" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(searches()).toHaveLength(0);
  });
});
