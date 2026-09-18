// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";

const ydoc = new Y.Doc();
const ytext = ydoc.getText("draft");

vi.mock("../lib/use-draft-session", () => ({
  useDraftSession: () => ({
    ytext,
    ready: true,
    meta: { sent_at: null, title: "Plan" },
    peers: {},
    publishCursor: () => {},
  }),
}));
vi.mock("@/features/chat/lib/send-to-agent", () => ({ sendToAgentChat: () => {} }));
/** Counts rebuilds, so the test can tell a reconfigure actually happened. */
const themeBuilds = vi.fn(() => []);
vi.mock("@/features/editor/themes/build-cm-theme", () => ({
  editorThemeExtensions: () => themeBuilds(),
}));

const { DraftEditor } = await import("./draft-editor");

afterEach(cleanup);

describe("DraftEditor across a theme apply", () => {
  /**
   * The regression: the theme revision was a dependency of the effect that
   * builds the EditorView, so every apply destroyed the view mid-edit — focus
   * and undo history went with it.
   */
  it("reconfigures the theme in place instead of rebuilding the editor", async () => {
    const { container } = render(
      <DraftEditor
        conv={{ id: "c", name: "general" } as never}
        draft={{ id: "d", title: "Plan" } as never}
      />,
    );
    const editor = container.querySelector(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor as HTMLElement)!;
    view.dispatch({ changes: { from: 0, insert: "hello" } });
    const builds = themeBuilds.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new CustomEvent("atlas:theme-applied"));
    });

    expect(container.querySelector(".cm-editor")).toBe(editor);
    expect(themeBuilds.mock.calls.length).toBe(builds + 1);
    expect(view.state.doc.toString()).toBe("hello");
  });
});
