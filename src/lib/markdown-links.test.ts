// @vitest-environment happy-dom
//
// A click on a file chip in rendered markdown opens the file it names; a
// click on a web link goes to the system browser; nothing else is taken.

import { beforeEach, describe, expect, it, vi } from "vitest";

const openPathLink = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/explorer/lib/open-path-link", () => ({ openPathLink }));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { parseMarkdown } from "./markdown-render";
import { onMarkdownClick, onMarkdownKeyDown } from "./markdown-links";

const ROOT = "/Users/dev/acme-app";

function render(src: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = parseMarkdown(src, ROOT);
  root.addEventListener("click", (e) => void onMarkdownClick(e));
  root.addEventListener("keydown", onMarkdownKeyDown);
  document.body.replaceChildren(root);
  return root;
}

/** Let the opener's dynamic import settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.clearAllMocks());

describe("clicks in rendered markdown", () => {
  it("opens a reply's path:line chip at its line", async () => {
    const root = render("See `src/lib/api.ts:42`.");
    root.querySelector<HTMLElement>(".atlas-file-chip .atlas-mention-chip__label")!.click();
    await settle();
    await vi.waitFor(() =>
      expect(openPathLink).toHaveBeenCalledWith({
        path: `${ROOT}/src/lib/api.ts`,
        line: 42,
        column: undefined,
        folder: false,
      }),
    );
  });

  it("opens a sent @folder chip as a folder", async () => {
    const root = render("@folder:src/lib");
    root.querySelector<HTMLElement>(".atlas-file-chip")!.click();
    await vi.waitFor(() =>
      expect(openPathLink).toHaveBeenCalledWith(
        expect.objectContaining({ path: `${ROOT}/src/lib`, folder: true }),
      ),
    );
  });

  it("opens a focused chip on Enter", async () => {
    const root = render("`src/a.ts`");
    const chip = root.querySelector<HTMLElement>(".atlas-file-chip")!;
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(openPathLink).toHaveBeenCalledTimes(1));
  });

  it("sends a web link to the system browser instead of navigating", async () => {
    const root = render("[docs](https://example.com/)");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/"));
    expect(openPathLink).not.toHaveBeenCalled();
  });

  it("leaves a click on plain text alone", () => {
    const root = render("just `code` here");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("code")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
