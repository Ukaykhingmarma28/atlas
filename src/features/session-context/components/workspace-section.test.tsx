// @vitest-environment happy-dom
//
// The project row opens an editor only when the user chose one; with
// "Automatic" it stays the file manager. Its menu lists every installed
// editor either way, closed off by a separator.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const revealItemInDir = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));

import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useExternalEditorStore } from "@/features/external-editor/stores/external-editor-store";
import { WorkspaceSection } from "./workspace-section";

const EDITORS = [
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "system", label: "System default" },
];

function setPreferred(id: string) {
  const { settings } = useSettingsStore.getState();
  useSettingsStore.setState({ settings: { ...settings, preferredEditor: id } });
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "external_editors_detect" ? EDITORS : null,
  );
  revealItemInDir.mockClear();
  useExternalEditorStore.setState({ editors: null });
  setPreferred("");
});
afterEach(() => cleanup());

async function mount() {
  render(<WorkspaceSection projectPath="/work/acme" />);
  await settle();
}

describe("WorkspaceSection", () => {
  it("stays the file manager with Automatic", async () => {
    await mount();
    fireEvent.click(screen.getByText(/^Open in (Finder|Explorer|file manager)$/));
    await settle();
    expect(revealItemInDir).toHaveBeenCalledWith("/work/acme");
    expect(invoke).not.toHaveBeenCalledWith("external_editor_open", expect.anything());
  });

  it("opens the editor the user chose", async () => {
    setPreferred("zed");
    await mount();
    fireEvent.click(screen.getByText("Open in Zed"));
    await settle();
    expect(invoke).toHaveBeenCalledWith("external_editor_open", {
      editor: "zed",
      path: "/work/acme",
      line: null,
      column: null,
    });
  });

  it("lists every editor in the menu, then a separator, even with Automatic", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Other ways to open the project" }));
    await settle();
    const items = (await screen.findAllByRole("menuitem")).map((el) => el.textContent);
    expect(items.slice(0, 2)).toEqual(["Open in Cursor", "Open in Zed"]);
    expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
  });
});
