// @vitest-environment happy-dom
//
// Finding a selected passage back in rendered prose: across inline elements,
// across block boundaries (a selection's text joins blocks with a newline),
// and with the whitespace the markdown renderer re-flowed.

import { describe, expect, it } from "vitest";

import { findPassageRange, highlightsSupported, indexText } from "./comment-highlights";

function prose(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("findPassageRange", () => {
  it("spans inline elements", () => {
    const root = prose("<p>Scope it to the <code>usage</code> page.</p>");
    const range = findPassageRange(root, "to the usage page");
    expect(range?.toString()).toBe("to the usage page");
  });

  it("crosses a block boundary the way a selection reads it", () => {
    const root = prose("<p>First line.</p><p>Second line.</p>");
    const range = findPassageRange(root, "line.\nSecond");
    expect(range?.toString()).toBe("line.Second");
  });

  it("collapses re-flowed whitespace on both sides", () => {
    const root = prose("<p>one\n  two   three</p>");
    expect(findPassageRange(root, "one two  three")?.toString()).toBe("one\n  two   three");
  });

  it("returns null for text that is not there, and for blank passages", () => {
    const root = prose("<p>hello</p>");
    expect(findPassageRange(root, "goodbye")).toBeNull();
    expect(findPassageRange(root, "   ")).toBeNull();
  });

  it("ignores the text of buttons inside the prose", () => {
    const root = prose("<pre><button>Copy</button>const x = 1;</pre>");
    expect(indexText(root).text).toBe("const x = 1;");
  });
});

describe("highlightsSupported", () => {
  it("is false where the browser has no Custom Highlight API", () => {
    expect(highlightsSupported()).toBe(false);
  });
});
