/**
 * Make a third-party SVG safe to inline.
 *
 * An icon theme is untrusted content: the user installed a `.vsix` from Open
 * VSX, which is an open registry anyone can publish to. Atlas inlines the SVG
 * rather than pointing an `<img>` at a data URL, because inlining is what lets
 * an icon that draws in `currentColor` follow the active colour theme — and
 * `<img>` deliberately will not run or inherit anything.
 *
 * Inlining means `innerHTML`, and `innerHTML` is where an icon theme could
 * become script execution. Two facts decide what this has to remove:
 *
 *   * a `<script>` element inserted through `innerHTML` does **not** run, but
 *   * an event-handler attribute does. `<svg onload=…>` and
 *     `<image href=x onerror=…>` both fire, because the parser sets the
 *     handler and the element then loads.
 *
 * So the pass is: parse with `DOMParser` (which never executes anything), drop
 * every element outside the allowlist, drop every `on*` attribute, and drop
 * any URL reference that is not a same-document fragment. What comes back is
 * drawing instructions and nothing else.
 *
 * Deliberately not a full SVG sanitiser: the allowlist covers the shape and
 * paint elements icon themes actually use. An icon that needs `<foreignObject>`
 * renders as whatever survives, which is the right failure — an icon that is
 * slightly wrong beats a theme that can run code.
 *
 * `<style>` is not on the list either, and that one is worth naming: CSS in an
 * inline SVG is *document*-scoped, not element-scoped, so one icon could
 * restyle the whole app. None of the 1,251 bundled Material icons contains a
 * `<style>` element — they paint with `fill` attributes — so the cost of
 * refusing it is a theme that was going to be a nuisance anyway.
 */

/** Elements an icon may contain. Everything else is dropped, children and all. */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "clippath",
  "mask",
  "pattern",
  "marker",
  "lineargradient",
  "radialgradient",
  "stop",
  "filter",
  "fegaussianblur",
  "feoffset",
  "feblend",
  "femerge",
  "femergenode",
  "fecolormatrix",
  "fecomposite",
  "feflood",
  "fedropshadow",
]);

/** Attributes whose value is a URL, and so must not reach the network. */
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "from", "to", "values"]);

/**
 * Strip everything that is not drawing.
 *
 * Returns `null` when the input is not parseable SVG at all, so the caller can
 * fall back to its own icon rather than render an empty box.
 */
export function sanitizeSvg(source: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  let document: Document;
  try {
    document = new DOMParser().parseFromString(source, "image/svg+xml");
  } catch {
    return null;
  }
  // `image/svg+xml` reports a malformed document as a `<parsererror>` element
  // rather than by throwing.
  if (document.querySelector("parsererror")) return null;
  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;

  scrub(root);

  // A theme's icon usually declares its own width/height in px. Sizing is the
  // caller's job here — the row decides how big an icon is — so the intrinsic
  // dimensions are dropped and `viewBox` (which carries the coordinate system)
  // is kept.
  root.removeAttribute("width");
  root.removeAttribute("height");
  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  root.setAttribute("focusable", "false");
  root.setAttribute("aria-hidden", "true");

  return new XMLSerializer().serializeToString(root);
}

/**
 * The only CSS properties an inline `style` may keep: paint and text, i.e.
 * things that change how the icon's own shapes look. Everything that changes
 * where a box sits — `position`, `inset`, `z-index`, `width`, `transform` — is
 * absent on purpose. An inline SVG is an ordinary box in the app's layout, so
 * `style="position:fixed;inset:0;z-index:…"` on its root would lay a
 * full-window overlay over Atlas, and that needs no `url()` at all.
 */
const ALLOWED_STYLE_PROPERTIES = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "stop-color",
  "stop-opacity",
  "flood-color",
  "flood-opacity",
  "clip-rule",
  "paint-order",
  "vector-effect",
  "shape-rendering",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
]);

function scrub(element: Element): void {
  // Both loops iterate a *snapshot*. `attributes` and `children` are live
  // collections: removing an entry while iterating the collection itself
  // shifts the index and silently skips the next one.
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    // `class` reaches the APP's stylesheet: `class="fixed inset-0 z-tooltip"`
    // is the same overlay as a hostile `style`, spelled in Tailwind. With
    // `<style>` gone an icon has no rules of its own for a class to select.
    if (name.startsWith("on") || name === "class") {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeReference(attribute.value)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "style") {
      const style = safeStyle(attribute.value);
      if (style) element.setAttribute(attribute.name, style);
      else element.removeAttribute(attribute.name);
      continue;
    }
    // A presentation attribute is a CSS value, so `fill`, `filter`, `mask`,
    // `clip-path` and `marker-*` all take a `url()` — and can point it off the
    // document. Checked on every attribute rather than a list of those, so a
    // property added to SVG later is covered too.
    if (!isSafeCssValue(attribute.value)) element.removeAttribute(attribute.name);
  }
  for (const child of Array.from(element.children)) {
    if (!ALLOWED_ELEMENTS.has(child.nodeName.toLowerCase())) {
      child.remove();
      continue;
    }
    scrub(child);
  }
}

/** Rebuild a `style` attribute from its allowlisted declarations, or `""`. */
function safeStyle(value: string): string {
  return value
    .split(";")
    .map((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon === -1) return null;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const propertyValue = declaration.slice(colon + 1).trim();
      if (!ALLOWED_STYLE_PROPERTIES.has(property) || !propertyValue) return null;
      if (!isSafeCssValue(propertyValue)) return null;
      return `${property}:${propertyValue}`;
    })
    .filter((declaration): declaration is string => declaration !== null)
    .join(";");
}

/**
 * A CSS value may reference only a same-document fragment: `url(#grad)` stays,
 * `url(https://…)` and `url(data:…)` go.
 *
 * A backslash fails outright. CSS resolves escapes before it recognises a
 * function name, so `\75 rl(https://…)` IS a `url()` to the browser and
 * invisible to a pattern that looks for the letters. No icon's paint or path
 * data has a reason to contain one. `image-set()` and friends take a URL
 * without the word `url`, so those fail too.
 */
function isSafeCssValue(value: string): boolean {
  if (value.includes("\\")) return false;
  if (/\b(?:image-set|image|cross-fade|element|src)\s*\(/i.test(value)) return false;
  const opened = value.match(/url\s*\(/gi)?.length ?? 0;
  const read = [...value.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)];
  // A `url(` the pattern could not read (unbalanced, mixed quotes) is not
  // given the benefit of the doubt.
  if (read.length !== opened) return false;
  return read.every((match) => match[2].trim().startsWith("#"));
}

/** Only a same-document fragment (`#gradient-1`) is allowed through. */
function isSafeReference(value: string): boolean {
  return value.trim().startsWith("#");
}
