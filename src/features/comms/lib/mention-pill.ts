// One definition of a mention pill, for the two places that draw one.
//
// The rendered message draws it in React (`components/message-body-impl`); the
// composer draws it as a CodeMirror widget, which is plain DOM
// (`lib/cm-comms-mention`). They must be indistinguishable — the point of the
// composer chip is that what you are typing already looks like what you are
// about to send — so the classes and the avatar markup live here rather than
// being written out twice and drifting.
//
// Shape follows the house pill (the transcript's "Scroll to bottom" button):
// fully round, a hairline border, an elevated fill.

import { avatarHue, initials } from "./derive";
import type { OrgMemberProfile } from "../types";

/** Avatar diameter. Sized so the pill clears 17px and still sits inside the
 *  12.5px/18px line box of both surfaces without stretching it. */
export const MENTION_AVATAR_SIZE = 13;

const BASE =
  "inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] align-middle " +
  "text-sm font-medium leading-none";

/** Addressed to you, or to everyone — the brighter of the two. */
const SELF = "border-border-strong bg-[var(--atlas-element-emphasis)] text-[var(--foreground)]";
/** Someone else: the same neutral surface every other pill in the app uses. */
const OTHER = "border-border bg-card text-secondary-foreground";

export function mentionPillClass(highlight: boolean): string {
  return `${BASE} ${highlight ? SELF : OTHER}`;
}

/**
 * Marker attributes both renderers put on the pill.
 *
 * A stable hook for tests and for anything that needs to find a mention in the
 * DOM: keying on the Tailwind classes means a colour tweak silently breaks the
 * selector, which is exactly what happened when this pill was restyled.
 */
export const MENTION_PILL_ATTR = "data-mention-pill";
export const MENTION_SELF_ATTR = "data-mention-self";

/**
 * A member's face as plain DOM, mirroring `CommsAvatar`.
 *
 * The hue derivation is shared rather than reimplemented: the same person is
 * the same colour in the titlebar, the transcript and here, and a second
 * derivation would eventually disagree with the first.
 */
export function avatarElement(
  member: OrgMemberProfile | null,
  size = MENTION_AVATAR_SIZE,
): HTMLElement {
  if (member?.image) {
    const img = document.createElement("img");
    img.src = member.image;
    img.alt = "";
    img.draggable = false;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.className = "rounded-full object-cover shrink-0";
    return img;
  }

  const fallback = document.createElement("span");
  fallback.setAttribute("aria-hidden", "true");
  fallback.style.width = `${size}px`;
  fallback.style.height = `${size}px`;
  fallback.style.fontSize = `${Math.round(size * 0.4)}px`;
  // ratchet-allow: an identity hue derived from the member id, not a theme colour.
  fallback.style.backgroundColor = member ? `hsl(${avatarHue(member.id)} 42% 40%)` : "var(--muted)";
  fallback.className =
    // ratchet-allow: the initials ride on that same identity hue, which is
    // saturated at a fixed lightness; white is what reads on all of them.
    "text-white/90 flex shrink-0 items-center justify-center rounded-full " +
    "font-medium leading-none select-none tracking-tight";
  fallback.textContent = initials(member?.name ?? "Unknown");
  return fallback;
}
