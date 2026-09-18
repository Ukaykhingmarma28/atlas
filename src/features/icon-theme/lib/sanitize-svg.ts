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

function scrub(element: Element): void {
  // Both loops iterate a *snapshot*. `attributes` and `children` are live
  // collections: removing an entry while iterating the collection itself
  // shifts the index and silently skips the next one.
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeReference(attribute.value)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    // `style` can smuggle a URL too (`background: url(javascript:…)`), and no
    // icon theme needs one in an inline style.
    if (name === "style" && /url\s*\(/i.test(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }
  for (const child of Array.from(element.children)) {
    if (!ALLOWED_ELEMENTS.has(child.nodeName.toLowerCase())) {
      child.remove();
      continue;
    }
    scrub(child);
  }
}

/** Only a same-document fragment (`#gradient-1`) is allowed through. */
function isSafeReference(value: string): boolean {
  return value.trim().startsWith("#");
}
