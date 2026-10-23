// @vitest-environment happy-dom
/**
 * The Files surface: one per project, and a hand-off rather than a place to
 * stay — opening a file from it closes it, because the file's tab carries the
 * same tree.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const treeProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("./project-file-tree", () => ({
  ProjectFileTree: (props: Record<string, unknown>) => {
    treeProps.current = props;
    return null;
  },
}));

import { revealFiles } from "@/features/layout/lib/files-surface";
import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { FilesPanel } from "./files-panel";

const tab = (id: string, type: Tab["type"], groupId: string): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data: {},
  groupId,
});

const layout = () => useLayoutStore.getState();

beforeEach(() => {
  treeProps.current = null;
  useProjectStore.setState({
    projects: [{ id: "w-1", name: "atlas", path: "/p" }] as never,
    activeProjectId: "w-1",
  });
  useLayoutStore.setState({
    tabs: [tab("chat-1", "chat", "main"), tab("terminal-1", "terminal", "g2")],
    groupOrder: ["main", "g2"],
    activeByGroup: { main: "chat-1", g2: "terminal-1" },
    focusedGroupId: "main",
    activeTabId: "chat-1",
    destination: null,
    destinationShown: false,
  });
});
afterEach(cleanup);

describe("Files surface", () => {
  it("opens beside the session, and opening it again focuses the one tab", () => {
    revealFiles();
    revealFiles();
    const files = layout().tabs.filter((t) => t.type === "files");
    expect(files).toHaveLength(1);
    expect(files[0].groupId).not.toBe("main");
    expect(layout().activeByGroup[files[0].groupId!]).toBe(files[0].id);
  });

  it("closes itself once a file it opened has its tab", async () => {
    revealFiles();
    const id = layout().tabs.find((t) => t.type === "files")!.id;
    render(<FilesPanel tabId={id} projectId="w-1" />);
    await waitFor(() => expect(treeProps.current).not.toBeNull());
    expect(treeProps.current!.root).toBe("/p");
    act(() => (treeProps.current!.onFileOpened as (p: string) => void)("/p/src/a.ts"));
    expect(layout().tabs.some((t) => t.type === "files")).toBe(false);
  });

  it("reveals a path asked for, again on a second ask, and follows the reader without one", async () => {
    revealFiles("/p/src/deep/a.ts");
    const id = layout().tabs.find((t) => t.type === "files")!.id;
    render(<FilesPanel tabId={id} projectId="w-1" />);
    await waitFor(() => expect(treeProps.current?.activeFile).toBe("/p/src/deep/a.ts"));
    const first = treeProps.current!.revealNonce;

    act(() => revealFiles("/p/src/deep/a.ts"));
    expect(treeProps.current!.activeFile).toBe("/p/src/deep/a.ts");
    expect(treeProps.current!.revealNonce).not.toBe(first);

    // Another project's path is not this tree's to show.
    act(() => revealFiles("/elsewhere/b.ts"));
    expect(treeProps.current!.activeFile).toBeUndefined();

    act(() => revealFiles());
    expect(treeProps.current!.activeFile).toBeUndefined();
  });
});
