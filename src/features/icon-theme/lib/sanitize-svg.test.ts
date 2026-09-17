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
