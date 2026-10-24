// What a click (or Enter) does on rendered markdown, for the two renderers
// that draw it from an HTML string: `CachedMarkdown` and the streaming tail.
// One delegated listener per rendered message, never one per chip or link.
//
//   - a file chip (`markdown-render.ts`) opens the file (`open-path-link.ts`);
//   - an http(s) link opens in the system browser, rather than navigating the
//     WKWebView away from Atlas.

/** The chip a click landed on, if it carries a target. */
function fileChipAt(target: EventTarget | null): HTMLElement | null {
  const el = (target as HTMLElement | null)?.closest?.(".atlas-file-chip[data-file-path]");
  return el instanceof HTMLElement ? el : null;
}

function openFileChip(chip: HTMLElement): void {
  const path = chip.dataset.filePath;
  if (!path) return;
  const line = Number(chip.dataset.fileLine) || undefined;
  const column = Number(chip.dataset.fileColumn) || undefined;
  const folder = chip.dataset.mentionKind === "folder";
  // Loaded on the first click: the opener pulls in the layout and file-index
  // code, which the markdown renderer has no reason to carry.
  void import("@/features/explorer/lib/open-path-link")
    .then((m) => m.openPathLink({ path, line, column, folder }))
    .catch(() => {});
}

/** Handle a click inside rendered markdown. True when it was taken. */
export function onMarkdownClick(e: MouseEvent): boolean {
  const chip = fileChipAt(e.target);
  if (chip) {
    e.preventDefault();
    openFileChip(chip);
    return true;
  }
  const anchor = (e.target as HTMLElement | null)?.closest?.("a");
  if (anchor instanceof HTMLAnchorElement && anchor.href && /^https?:/i.test(anchor.href)) {
    e.preventDefault();
    const href = anchor.href;
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch(() => {});
    return true;
  }
  return false;
}

/** Enter or Space on a focused file chip opens it, as a click would. */
export function onMarkdownKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  const chip = fileChipAt(e.target);
  if (!chip || chip !== e.target) return;
  e.preventDefault();
  openFileChip(chip);
}
