import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({
  isMac: false,
  isWindows: false,
  isLinux: true,
}));

import { displayKeys, displayLabel, parseCombo } from "./combo";

describe("display on Linux", () => {
  it("renders Super for meta when ctrl is present, Ctrl for cmd when ctrl is absent", () => {
    // When a combo has cmd (meta: true) on Linux without ctrl:
    expect(displayKeys(parseCombo("cmd+b")!)).toEqual(["Ctrl", "B"]);
    expect(displayLabel(parseCombo("cmd+b")!)).toBe("Ctrl+B");

    // When both ctrl and cmd (meta) are present, meta displays as Super:
    expect(displayKeys(parseCombo("cmd+ctrl+k")!)).toEqual(["Ctrl", "Super", "K"]);
    expect(displayLabel(parseCombo("cmd+ctrl+k")!)).toBe("Ctrl+Super+K");

    // Modifiers order: Ctrl, Super, Alt, Shift
    expect(displayKeys(parseCombo("cmd+ctrl+alt+shift+k")!)).toEqual([
      "Ctrl",
      "Super",
      "Alt",
      "Shift",
      "K",
    ]);
    expect(displayLabel(parseCombo("cmd+ctrl+alt+shift+k")!)).toBe("Ctrl+Super+Alt+Shift+K");

    // Plain shift+tab
    expect(displayKeys(parseCombo("shift+tab")!)).toEqual(["Shift", "⇥"]);
    expect(displayLabel(parseCombo("shift+tab")!)).toBe("Shift+⇥");

    // Parses 'super' and 'win' as meta
    expect(parseCombo("super+k")).toEqual({
      code: "KeyK",
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(parseCombo("win+shift+b")).toEqual({
      code: "KeyB",
      meta: true,
      ctrl: false,
      shift: true,
      alt: false,
    });
  });
});
