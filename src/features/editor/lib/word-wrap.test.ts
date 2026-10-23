// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { setWordWrap, wordWrapExtension } from "./word-wrap";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function viewWith(wrap: boolean): EditorView {
  const view = new EditorView({
    doc: "a line long enough that it would scroll sideways",
    extensions: [wordWrapExtension(wrap)],
    parent: document.body,
  });
  views.push(view);
  return view;
}

const wraps = (view: EditorView) => view.contentDOM.classList.contains("cm-lineWrapping");

describe("word wrap compartment", () => {
  it("starts wrapped or not as the setting says", () => {
    expect(wraps(viewWith(true))).toBe(true);
    expect(wraps(viewWith(false))).toBe(false);
  });

  it("follows the setting in place, keeping the document and its history", () => {
    const view = viewWith(true);
    view.dispatch({ changes: { from: 0, insert: "edited " } });
    const doc = view.state.doc;

    setWordWrap(view, false);
    expect(wraps(view)).toBe(false);
    setWordWrap(view, true);
    expect(wraps(view)).toBe(true);

    // Reconfigured, not rebuilt: the edited document carries straight on.
    expect(view.state.doc).toBe(doc);
  });
});
