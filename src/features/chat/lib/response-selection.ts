export const RESPONSE_SELECTOR = "[data-agent-response]";
const CONTROL_SELECTOR =
  'button, input, textarea, select, [role="button"], [contenteditable="true"]';

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

export function responseAt(node: Node | null, viewport: HTMLElement): HTMLElement | null {
  const element = elementOf(node);
  if (element?.closest(CONTROL_SELECTOR)) return null;
  const response = element?.closest<HTMLElement>(RESPONSE_SELECTOR);
  return response && viewport.contains(response) ? response : null;
}

/** A range belongs to one completed response, never two rows or UI chrome. */
export function selectedResponse(selection: Selection | null, viewport: HTMLElement) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const response = responseAt(range.startContainer, viewport);
  if (!response || responseAt(range.endContainer, viewport) !== response) return null;
  // Endpoints can be in valid text while the range crosses a toolbar.
  if (range.cloneContents().querySelector(CONTROL_SELECTOR)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  return { response, text, range };
}

/** Clamp in the transcript's coordinate system. The panel can be CSS-scaled;
 * DOM rects are screen pixels but absolute positions are layout pixels. */
export function actionPosition(
  bounds: DOMRect,
  size: { width: number; height: number; offsetWidth: number; offsetHeight: number },
  anchor: { x: number; top: number; bottom: number },
  popup: { width: number; height: number },
) {
  const sx = bounds.width / size.offsetWidth || 1;
  const sy = bounds.height / size.offsetHeight || 1;
  const gap = 8;
  const x = (anchor.x - bounds.left) / sx;
  const below = (anchor.bottom - bounds.top) / sy + gap;
  const above = (anchor.top - bounds.top) / sy - popup.height - gap;
  return {
    left: Math.max(gap, Math.min(x, size.width - popup.width - gap)),
    top: Math.max(
      gap,
      Math.min(
        below + popup.height <= size.height - gap ? below : above,
        size.height - popup.height - gap,
      ),
    ),
  };
}

/** Existing targeted inserts carry a complete draft. Cite opts into appending
 * to the live editor, whose last keystrokes may not have reached the store. */
export interface ChatInsertDetail {
  text: string;
  tabId?: string;
  append?: boolean;
}

export function insertedDraft(current: string, detail: ChatInsertDetail): string {
  if (detail.tabId && !detail.append) return detail.text;
  return current.trim() ? `${current}\n\n${detail.text}` : detail.text;
}
