// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize-svg";

/**
 * The icons that reach `dangerouslySetInnerHTML` come from a `.vsix` the user
 * installed off Open VSX, which anyone may publish to. These are the cases
 * that would turn an icon theme into script execution, plus the ones that
 * would make a perfectly good icon render wrong.
 */
describe("sanitizeSvg", () => {
  it("keeps the drawing, and the paint that makes it follow the theme", () => {
    // `currentColor` rather than a hex on purpose, and not only to stay off
    // the design-system ratchet: it is the property that inlining exists for.
    // An <img> would render this icon in its authored colour forever.
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" stroke="tomato" d="M2 2v12h12V2z"/></svg>',
    );
    expect(out).toContain('d="M2 2v12h12V2z"');
    expect(out).toContain('fill="currentColor"');
    expect(out).toContain('stroke="tomato"');
    expect(out).toContain('viewBox="0 0 16 16"');
  });

  it("strips event handlers, which DO fire when inserted as markup", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 16 16"><rect width="16" height="16" onclick="alert(2)"/></svg>',
    );
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert");
    expect(out).toContain("<rect");
  });

  it("drops elements outside the drawing allowlist", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><circle r="4"/></svg>',
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("foreignObject");
    expect(out).toContain("<circle");
  });

  it("drops <style>, because CSS inside inline SVG escapes the icon", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>*{display:none}</style><path d="M0 0"/></svg>',
    );
    expect(out).not.toContain("display:none");
    expect(out).toContain("<path");
  });

  it("keeps a same-document reference and drops an external one", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#glyph"/><use href="https://evil.invalid/x.svg#a"/></svg>',
    );
    expect(out).toContain('href="#glyph"');
    expect(out).not.toContain("evil.invalid");
  });

  it("drops a style attribute that smuggles a URL", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(javascript:alert(1))"/></svg>',
    );
    expect(out).not.toContain("javascript:");
  });

  /**
   * The overlay attack needs no URL and no script: an inline SVG is a box in
   * the app's own layout, so `position:fixed; inset:0` on it covers the window
   * — a phishing surface drawn by an icon theme.
   */
  it("drops layout from a style attribute and keeps the paint", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" style="position:fixed;inset:0;z-index:2147483647;width:100vw"><path style="fill:currentColor;stroke-width:2;transform:scale(99)" d="M0 0"/></svg>',
    )!;
    expect(out).not.toMatch(/position|inset|z-index|100vw|transform/);
    expect(out).toContain('style="fill:currentColor;stroke-width:2"');
  });

  it("drops a class, which would reach the app's own utilities", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" class="fixed inset-0 z-tooltip"><path class="x" d="M0 0"/></svg>',
    );
    expect(out).not.toContain("class=");
    expect(out).not.toContain("inset-0");
  });

  it("keeps a same-document url() in paint and drops an external one", () => {
    const out = sanitizeSvg(
      [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        '<rect fill="url(#grad)" mask="url(\'#m\')"/>',
        '<rect fill="url(https://evil.invalid/a.svg#g)" filter="url( data:image/svg+xml,x )"/>',
        '<circle clip-path="url(&quot;//evil.invalid/c&quot;)" marker-end="url(#ok) url(http://evil.invalid)"/>',
        "</svg>",
      ].join(""),
    )!;
    expect(out).toContain('fill="url(#grad)"');
    expect(out).toContain("mask=");
    expect(out).not.toContain("evil.invalid");
    expect(out).not.toContain("data:image");
  });

  it("drops a url() spelled with a CSS escape or hidden in image-set()", () => {
    const out = sanitizeSvg(
      [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        '<rect fill="\\75 rl(https://evil.invalid/x)"/>',
        '<rect style="fill:image-set(&quot;https://evil.invalid/y&quot; 1x)"/>',
        "</svg>",
      ].join(""),
    )!;
    expect(out).not.toContain("evil.invalid");
  });

  it("hands sizing back to the call site", () => {
    // A theme's icon usually hardcodes 32×32; the row decides how big it is.
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M0 0"/></svg>',
    );
    expect(out).toContain('width="100%"');
    expect(out).toContain('height="100%"');
    expect(out).toContain('viewBox="0 0 32 32"');
  });

  it("refuses anything that is not an SVG document", () => {
    expect(sanitizeSvg("not markup at all <<<")).toBeNull();
    expect(sanitizeSvg("<html><body>hi</body></html>")).toBeNull();
    expect(sanitizeSvg("")).toBeNull();
  });
});
