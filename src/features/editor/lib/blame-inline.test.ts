// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { applyBlame, blameInline, relativeTime, type BlamePart } from "./blame-inline";
import { setWordWrap, wordWrapExtension } from "./word-wrap";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const ago = (seconds: number) => relativeTime(NOW - seconds * 1000, NOW);
const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Expected strings are what `git log --format=%cr` prints for the same gap. */
describe("relativeTime matches git's %cr", () => {
  it("rounds hours to nearest, as History does", () => {
    // 22h40m: the floor version said "22 hours ago" beside History's "23".
    expect(ago(22 * HOUR + 40 * MIN)).toBe("23 hours ago");
    expect(ago(22 * HOUR + 20 * MIN)).toBe("22 hours ago");
  });

  it("keeps git's thresholds between units", () => {
    expect(ago(45)).toBe("45 seconds ago");
    expect(ago(89)).toBe("89 seconds ago");
    expect(ago(80 * MIN)).toBe("80 minutes ago");
    expect(ago(30 * HOUR)).toBe("30 hours ago");
    expect(ago(36 * HOUR)).toBe("2 days ago");
    expect(ago(1 * DAY + 13 * HOUR)).toBe("2 days ago");
    expect(ago(20 * DAY)).toBe("3 weeks ago");
    expect(ago(100 * DAY)).toBe("3 months ago");
  });

  it("says years and months, then whole years", () => {
    expect(ago(400 * DAY)).toBe("1 year, 1 month ago");
    expect(ago(730 * DAY)).toBe("2 years ago");
    expect(ago(2000 * DAY)).toBe("5 years ago");
  });

  it("is empty for a line with no commit time", () => {
    expect(relativeTime(0, NOW)).toBe("");
  });
});

describe("the inline blame widget", () => {
  it("keeps its gap inside its box, so the caret is not pushed past it", () => {
    // The widget sits at the end of the active line, and CodeMirror draws a
    // caret there at the widget's box. A `margin-left` lies outside that box:
    // the caret was drawn 2em past the text — an "indent" on every empty line.
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "", extensions: [blameInline()] }),
    });
    const css = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const rule = css.match(/\.cm-blame-inline[^{]*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("padding-left");
    expect(rule).not.toContain("margin");
    view.destroy();
  });
});

describe("inline blame with word wrap", () => {
  /// The note must never change a line's height. Drawn inline in a wrapping
  /// editor it added visual rows to whichever line held the cursor, so the
  /// text below jumped at every arrow key and an "open at line" target grew
  /// after it was centred. With wrap on, nothing is drawn in the text at all;
  /// the attribution goes to the header instead.
  it("draws nothing in the text while wrapping, and hands the header the attribution", () => {
    const sink = vi.fn<(parts: BlamePart[] | null) => void>();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "a long first line\nsecond",
        extensions: [wordWrapExtension(true), blameInline({ onWrapped: sink })],
      }),
    });
    applyBlame(view, [
      {
        line: 1,
        sha: "abc",
        shortSha: "abc",
        author: "Ada",
        timeMs: 0,
        summary: "first",
        committed: true,
      },
    ]);
    const inText = () => view.contentDOM.querySelector(".cm-blame-inline");

    expect(inText()).toBeNull();
    expect(sink).toHaveBeenLastCalledWith([
      { kind: "author", text: "Ada" },
      { kind: "sep", text: " · " },
      { kind: "summary", text: "first" },
    ]);

    // Without wrap it is the inline note it always was, and the header clears.
    setWordWrap(view, false);
    expect(inText()).not.toBeNull();
    expect(sink).toHaveBeenLastCalledWith(null);

    setWordWrap(view, true);
    expect(inText()).toBeNull();
    expect(sink.mock.lastCall?.[0]?.[0]).toEqual({ kind: "author", text: "Ada" });

    view.destroy();
    expect(sink).toHaveBeenLastCalledWith(null);
  });
});
