import { describe, expect, it } from "vitest";

import {
  CONTEXT_CARD_CLEARANCE,
  CONTEXT_CARD_GAP,
  CONTEXT_CARD_WIDTH,
  CONTEXT_DOCK_LEFT_INSET,
  parseColumnMax,
  resolveContextDock,
} from "./context-dock";

/** Where the column lands: centred in the row less `inset` and `reserve`. */
function columnBox(width: number, columnMax: number) {
  const { reserve, inset } = resolveContextDock(width, columnMax);
  const box = width - inset - reserve;
  const column = Math.min(columnMax, box);
  const left = inset + (box - column) / 2;
  return { left, right: left + column, column };
}

const cardLeft = (width: number) => width - CONTEXT_CARD_GAP - CONTEXT_CARD_WIDTH;

describe("resolveContextDock", () => {
  it("reserves nothing on a panel wide enough that the centred column clears the card", () => {
    expect(resolveContextDock(1600, 760)).toEqual({ docked: true, reserve: 0, inset: 0 });
  });

  it("slides the column left, unnarrowed, until it clears the card", () => {
    const width = 1200;
    const { left, right, column } = columnBox(width, 760);
    expect(column).toBe(760);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(cardLeft(width) - CONTEXT_CARD_CLEARANCE);
  });

  it("narrows the column only once it has slid to the turn rail's gutter", () => {
    const width = 1000;
    const { left, right, column } = columnBox(width, 760);
    expect(left).toBe(CONTEXT_DOCK_LEFT_INSET);
    expect(column).toBeLessThan(760);
    expect(right).toBeLessThanOrEqual(cardLeft(width) - CONTEXT_CARD_CLEARANCE);
  });

  it("keeps the gutter the column had undocked, up to the turn rail's width", () => {
    for (const width of [960, 1000, 1100, 1200, 1440, 2000]) {
      for (const columnMax of [760, 1080]) {
        if (!resolveContextDock(width, columnMax).docked) continue;
        const undocked = Math.max(0, (width - Math.min(columnMax, width)) / 2);
        expect(columnBox(width, columnMax).left).toBeGreaterThanOrEqual(
          Math.min(CONTEXT_DOCK_LEFT_INSET, undocked),
        );
      }
    }
  });

  it("does not dock where the column beside the card would be unreadable", () => {
    expect(resolveContextDock(800, 760)).toEqual({ docked: false, reserve: 0, inset: 0 });
    expect(resolveContextDock(0, 760)).toEqual({ docked: false, reserve: 0, inset: 0 });
  });

  it("keeps a full-width column clear of the card, and gives it no gutter it lacked", () => {
    const width = 1400;
    const { left, right } = columnBox(width, Number.POSITIVE_INFINITY);
    expect(left).toBe(0);
    expect(right).toBeLessThanOrEqual(cardLeft(width) - CONTEXT_CARD_CLEARANCE);
  });

  it("depends on the width alone, so opening the card cannot move the column", () => {
    // The function takes no open state; the same width is the same layout.
    for (const width of [900, 1100, 1440, 2000]) {
      expect(resolveContextDock(width, 760)).toEqual(resolveContextDock(width, 760));
    }
    expect(resolveContextDock.length).toBe(2);
  });
});

describe("parseColumnMax", () => {
  it("reads px and treats anything else as unbounded", () => {
    expect(parseColumnMax("760px")).toBe(760);
    expect(parseColumnMax(" 1080px ")).toBe(1080);
    expect(parseColumnMax("100%")).toBe(Number.POSITIVE_INFINITY);
    expect(parseColumnMax("")).toBe(Number.POSITIVE_INFINITY);
  });
});
