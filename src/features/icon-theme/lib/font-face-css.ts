import type { IconFontFace } from "./icon-theme-api";

/**
 * `@font-face` text for a glyph icon theme's fonts.
 *
 * Every field here comes out of a `.vsix` the user installed off Open VSX, and
 * it lands in a `<style>` element as TEXT — so a font id of
 * `x"; } body { display: none } @font-face { font-family: "y` is not a font
 * name, it is a stylesheet. Nothing is interpolated as written: the id is
 * reduced to identifier characters, and weight, style, format and URL are
 * checked against what a font descriptor can actually hold. A value that
 * fails is dropped (the descriptor's default applies), never quoted and
 * passed through.
 */

/** A font id reduced to characters that are inert inside a quoted family name
 *  AND usable unquoted in an inline `font-family`. The same function names the
 *  family at the `@font-face` and at every glyph that uses it, so they agree. */
export function safeFontIdent(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `normal`, `bold`, a keyword, or a 1–1000 number — optionally a range. */
const WEIGHT = /^(?:normal|bold|bolder|lighter|\d{1,4}(?:\s+\d{1,4})?)$/;
const STYLE = /^(?:normal|italic|oblique)$/;
/** VS Code's `format` values, mapped onto the CSS `format()` keywords. */
const FORMATS: Record<string, string> = {
  woff: "woff",
  woff2: "woff2",
  truetype: "truetype",
  ttf: "truetype",
  opentype: "opentype",
  otf: "opentype",
  "embedded-opentype": "embedded-opentype",
  svg: "svg",
};
/** Rust hands every face back as base64 `data:` — anything else is not ours. */
const DATA_URL = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;

export function fontFaceCss(family: string, font: IconFontFace): string {
  const src = font.src
    .filter((source) => DATA_URL.test(source.url))
    .map((source) => {
      const format = FORMATS[source.format.toLowerCase()];
      return format ? `url("${source.url}") format("${format}")` : `url("${source.url}")`;
    })
    .join(", ");
  if (!src) return "";
  const weight = font.weight?.trim() ?? "";
  const style = font.style?.trim().toLowerCase() ?? "";
  return [
    "@font-face {",
    `  font-family: "${safeFontIdent(family)}";`,
    `  src: ${src};`,
    `  font-weight: ${WEIGHT.test(weight) ? weight : "normal"};`,
    `  font-style: ${STYLE.test(style) ? style : "normal"};`,
    "}",
  ].join("\n");
}
