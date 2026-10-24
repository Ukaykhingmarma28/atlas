// @vitest-environment happy-dom
//
// File paths in rendered session markdown: which become chips, what a chip
// carries, and that fenced code and web links are left alone.

import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown-render";

const ROOT = "/Users/dev/acme-app";

/** Every file chip's target and label, in order. */
function fileChips(html: string): { path: string; line?: string; label: string }[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll<HTMLElement>(".atlas-file-chip")].map((el) => ({
    path: el.dataset.filePath ?? "",
    ...(el.dataset.fileLine ? { line: el.dataset.fileLine } : {}),
    label: el.querySelector(".atlas-mention-chip__label")?.textContent ?? "",
  }));
}

describe("file paths as chips", () => {
  it("turns inline code naming a project file into a chip with an icon slot", () => {
    const html = parseMarkdown("Read `src/lib/api.ts:42` first.", ROOT);
    expect(fileChips(html)).toEqual([
      { path: `${ROOT}/src/lib/api.ts`, line: "42", label: "src/lib/api.ts:42" },
    ]);
    expect(html).toContain(`data-file-icon="file"`);
    expect(html).toContain(`title="${ROOT}/src/lib/api.ts:42"`);
    expect(html).toContain(`role="link"`);
    expect(html).not.toContain("<code>src/lib/api.ts:42</code>");
  });

  it("leaves code that is not a project file alone", () => {
    const html = parseMarkdown(
      "`https://example.com/a.ts` `1.2.3` `e.g.` `src/**/*.ts` `/etc/hosts` `useState`",
      ROOT,
    );
    expect(fileChips(html)).toEqual([]);
    expect(html).toContain("<code>src/**/*.ts</code>");
  });

  it("never touches a fenced block", () => {
    const html = parseMarkdown('```ts\nimport x from "src/a.ts";\n// src/b.ts:3\n```', ROOT);
    expect(fileChips(html)).toEqual([]);
    expect(html).toContain("<pre>");
  });

  it("does nothing without a project root", () => {
    expect(fileChips(parseMarkdown("`src/lib/api.ts`"))).toEqual([]);
  });

  it("replaces a link whose text is its path, and keeps a link's own words", () => {
    const own = parseMarkdown("[src/lib/utils.ts](src/lib/utils.ts)", ROOT);
    expect(fileChips(own)).toEqual([
      { path: `${ROOT}/src/lib/utils.ts`, label: "src/lib/utils.ts" },
    ]);
    expect(own).not.toContain("<a ");

    const worded = parseMarkdown("See [the helper](src/lib/api.ts#L10).", ROOT);
    expect(fileChips(worded)).toEqual([
      { path: `${ROOT}/src/lib/api.ts`, line: "10", label: "src/lib/api.ts#L10" },
    ]);
    expect(worded).toContain("the helper");
    expect(worded).not.toContain("<a ");
  });

  it("keeps a web link a link", () => {
    const html = parseMarkdown("[docs](https://example.com/a.ts)", ROOT);
    expect(fileChips(html)).toEqual([]);
    expect(html).toContain(`href="https://example.com/a.ts"`);
  });

  it("gives a sent @file or @folder mention its absolute target and an icon slot", () => {
    const html = parseMarkdown("@file:src/lib/a.ts and @folder:src/lib", ROOT);
    expect(fileChips(html)).toEqual([
      { path: `${ROOT}/src/lib/a.ts`, label: "a.ts" },
      { path: `${ROOT}/src/lib`, label: "lib" },
    ]);
    expect(html).toContain(`data-file-icon="folder"`);
  });

  it("labels inline code as written, so two index.ts files stay apart", () => {
    const html = parseMarkdown("`src/a/index.ts` and `src/b/index.ts`", ROOT);
    expect(fileChips(html).map((c) => c.label)).toEqual(["src/a/index.ts", "src/b/index.ts"]);
    // Copying the reply copies the paths.
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.textContent).toContain("src/a/index.ts and src/b/index.ts");
  });

  it("opens an out-of-project mention only in a message the user wrote", () => {
    const src = "@file:/Applications/Calculator.app and @folder:/etc";
    // An agent's reply: drawn, never clickable.
    for (const html of [parseMarkdown(src, ROOT), parseMarkdown(src)]) {
      expect(fileChips(html).map((c) => c.path)).toEqual(["", ""]);
      expect(html).not.toContain(`role="link"`);
    }
    // The user's own message: they attached those themselves.
    const sent = parseMarkdown(src, ROOT, { userAuthored: true });
    expect(fileChips(sent).map((c) => c.path)).toEqual(["/Applications/Calculator.app", "/etc"]);
    // Inside the project, a reply's mention still opens.
    expect(fileChips(parseMarkdown("@file:src/a.ts", ROOT))).toEqual([
      { path: `${ROOT}/src/a.ts`, label: "a.ts" },
    ]);
  });

  it("makes a bundle a folder chip", () => {
    const html = parseMarkdown("Built `build/Foo.app`.", ROOT);
    expect(html).toContain(`data-mention-kind="folder"`);
    expect(fileChips(html)).toEqual([{ path: `${ROOT}/build/Foo.app`, label: "build/Foo.app" }]);
  });

  it("draws a mention it cannot resolve with an icon but no target", () => {
    const html = parseMarkdown("@file:src/lib/a.ts");
    expect(html).toContain(`data-file-icon="file"`);
    expect(html).not.toContain(`role="link"`);
  });
});
