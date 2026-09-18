/**
 * The styled run that terminal output renders as.
 *
 * The emulation that produces these lives in `line-emulator.ts`, which the
 * block parser drives INCREMENTALLY as output streams. Runs are `{ text, style }`
 * pairs that React renders as <span>s — no dangerouslySetInnerHTML.
 */
import type { CSSProperties } from "react";

export interface AnsiSegment {
  text: string;
  style?: CSSProperties;
}
