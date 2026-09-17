// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// The editor stack imports modules that subscribe to Tauri events on load.
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { buildExtensions } from "../lib/extensions";
import { restoreWikilinks } from "./wikilink-text";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Load markdown into the real editor stack and serialize it back. */
function roundTrip(markdown: string): string {
  editor = new Editor({ extensions: buildExtensions(), content: markdown });
  const storage = editor.storage as unknown as Record<string, { getMarkdown: () => string }>;
  return storage.markdown.getMarkdown();
}

describe("WikilinkText", () => {
  it("keeps wikilinks unescaped through a save", () => {
    expect(roundTrip("See [[roadmap-q4]] and [[architecture/auth-flow]].")).toBe(
      "See [[roadmap-q4]] and [[architecture/auth-flow]].",
    );
  });

  it("keeps wikilinks inside lists and headings", () => {
    const md = "# Links to [[overview]]\n\n- first [[a]]\n- second [[b]]";
    expect(roundTrip(md)).toBe(md);
  });

  it("still escapes other markdown characters", () => {
    expect(roundTrip("literal \\*stars\\* and \\[brackets\\]")).toBe(
      "literal \\*stars\\* and \\[brackets\\]",
    );
  });

  it("serializes plain text exactly as before", () => {
    expect(roundTrip("a < b and snake_case")).toBe("a &lt; b and snake_case");
  });
});

describe("restoreWikilinks", () => {
  it("unescapes characters inside the link target", () => {
    expect(restoreWikilinks("\\[\\[notes/\\_draft\\]\\]")).toBe("[[notes/_draft]]");
  });

  it("leaves a wikilink followed by a URL escaped", () => {
    expect(restoreWikilinks("\\[\\[x\\]\\](https://a.b)")).toBe("\\[\\[x\\]\\](https://a.b)");
  });

  it("leaves targets Rust would reject escaped", () => {
    const long = "a".repeat(200);
    expect(restoreWikilinks(`\\[\\[${long}\\]\\]`)).toBe(`\\[\\[${long}\\]\\]`);
    expect(restoreWikilinks("\\[\\[\\]\\]")).toBe("\\[\\[\\]\\]");
  });
});
