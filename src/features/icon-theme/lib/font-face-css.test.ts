import { describe, expect, it } from "vitest";
import { fontFaceCss, safeFontIdent } from "./font-face-css";

/**
 * Every field of an icon font comes from a `.vsix` off Open VSX and is written
 * into a `<style>` as text, so a field that closes the rule is a stylesheet.
 */
const FONT = "data:font/woff2;base64,d09GMgABAAAAA==";

describe("fontFaceCss", () => {
  it("writes an ordinary face unchanged", () => {
    const css = fontFaceCss("atlas-icon-font-seti", {
      id: "seti",
      weight: "400",
      style: "normal",
      src: [{ format: "woff2", url: FONT }],
    });
    expect(css).toContain('font-family: "atlas-icon-font-seti";');
    expect(css).toContain(`src: url("${FONT}") format("woff2");`);
    expect(css).toContain("font-weight: 400;");
    expect(css).toContain("font-style: normal;");
  });

  it("cannot be broken out of by a hostile id, weight, style or format", () => {
    const escape = '"; } body { display: none } @font-face { font-family: "x';
    const css = fontFaceCss(`atlas-icon-font-${escape}`, {
      id: escape,
      weight: "bold; } * { visibility: hidden } x {",
      style: "italic } body { opacity: 0",
      src: [{ format: 'woff2") } body { display:none } x { src: url("', url: FONT }],
    });
    // Exactly one rule: nothing closed it early. (The family may still SPELL
    // "body" — as inert identifier characters inside its quotes.)
    expect(css.match(/[{}]/g)).toEqual(["{", "}"]);
    expect(css).toMatch(/font-family: "[A-Za-z0-9_-]+";/);
    expect(css).not.toMatch(/visibility|opacity|display:none/);
    expect(css).toContain("font-weight: normal;");
    expect(css).toContain("font-style: normal;");
  });

  it("drops a source that is not the base64 data URL Rust produces", () => {
    const css = fontFaceCss("f", {
      id: "f",
      src: [
        { format: "woff", url: 'https://evil.invalid/x.woff") } body { display: none } x {' },
        { format: "woff", url: FONT },
      ],
    });
    expect(css).not.toContain("evil.invalid");
    expect(css).toContain(FONT);
    expect(fontFaceCss("f", { id: "f", src: [{ format: "woff", url: "https://x/y" }] })).toBe("");
  });

  it("names the family the same way at the face and at the glyph", () => {
    expect(safeFontIdent('a"b c')).toBe("a_b_c");
    expect(fontFaceCss('a"b c', { id: "x", src: [{ format: "woff2", url: FONT }] })).toContain(
      `font-family: "${safeFontIdent('a"b c')}";`,
    );
  });
});
