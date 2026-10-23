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
      { path: `${ROOT}/src/lib/api.ts`, line: "42", label: "api.ts:42" },
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
    expect(fileChips(own)).toEqual([{ path: `${ROOT}/src/lib/utils.ts`, label: "utils.ts" }]);
    expect(own).not.toContain("<a ");

    const worded = parseMarkdown("See [the helper](src/lib/api.ts#L10).", ROOT);
    expect(fileChips(worded)).toEqual([
      { path: `${ROOT}/src/lib/api.ts`, line: "10", label: "api.ts:10" },
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

  it("draws a mention it cannot resolve with an icon but no target", () => {
    const html = parseMarkdown("@file:src/lib/a.ts");
    expect(html).toContain(`data-file-icon="file"`);
    expect(html).not.toContain(`role="link"`);
  });
});
