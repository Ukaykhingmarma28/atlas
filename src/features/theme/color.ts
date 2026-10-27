export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function parseChannel(value: string): number {
  return value.endsWith("%") ? (Number.parseFloat(value) / 100) * 255 : Number.parseFloat(value);
}

function parseAlpha(value: string | undefined): number {
  if (!value) return 1;
  return clamp(value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value));
}

function hslToRgb(hue: number, saturation: number, lightness: number): RgbaColor {
  // Into [0, 1): `% 360` alone leaves a negative hue negative, and the old
  // `(hue % 360 + 360) / 360` landed in [1, 2), which the channel wrap below
  // (one step of ±1) cannot bring back for a hue past 240° — magenta read as blue.
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clamp(saturation);
  const l = clamp(lightness);
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a: 1 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(1 / 3) * 255, g: channel(0) * 255, b: channel(-1 / 3) * 255, a: 1 };
}

function oklchToRgb(lightness: number, chroma: number, hue: number): RgbaColor {
  const radians = (hue * Math.PI) / 180;
  return fromOklab([lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)], 1);
}

function functionParts(value: string): { name: string; channels: string[]; alpha?: string } | null {
  const match = value.trim().match(/^(rgb|rgba|hsl|hsla|oklch)\((.*)\)$/i);
  if (!match) return null;
  const pieces = match[2].replaceAll(",", " ").replace("/", " / ").split(/\s+/).filter(Boolean);
  const slash = pieces.indexOf("/");
  const channels = slash >= 0 ? pieces.slice(0, slash) : pieces;
  const alpha = slash >= 0 ? pieces[slash + 1] : channels.length === 4 ? channels.pop() : undefined;
  return { name: match[1].toLowerCase(), channels, alpha };
}

export function parseColor(value: string): RgbaColor | null {
  const hex = value.trim().match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => part + part).join("") : hex;
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const parsed = functionParts(value);
  if (!parsed || parsed.channels.length !== 3) return null;
  if (parsed.name.startsWith("rgb")) {
    const [r, g, b] = parsed.channels.map(parseChannel);
    if (![r, g, b].every(Number.isFinite)) return null;
    return {
      r: clamp(r, 0, 255),
      g: clamp(g, 0, 255),
      b: clamp(b, 0, 255),
      a: parseAlpha(parsed.alpha),
    };
  }
  if (parsed.name.startsWith("hsl")) {
    const [h, s, l] = parsed.channels;
    const color = hslToRgb(
      Number.parseFloat(h),
      Number.parseFloat(s) / 100,
      Number.parseFloat(l) / 100,
    );
    return { ...color, a: parseAlpha(parsed.alpha) };
  }
  const [l, c, h] = parsed.channels;
  const lightness = l.endsWith("%") ? Number.parseFloat(l) / 100 : Number.parseFloat(l);
  const color = oklchToRgb(lightness, Number.parseFloat(c), Number.parseFloat(h));
  return { ...color, a: parseAlpha(parsed.alpha) };
}

export function colorToCss(color: RgbaColor): string {
  const r = Math.round(clamp(color.r, 0, 255));
  const g = Math.round(clamp(color.g, 0, 255));
  const b = Math.round(clamp(color.b, 0, 255));
  const a = Math.round(clamp(color.a) * 1000) / 1000;
  return a === 1
    ? `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
    : `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function withAlpha(value: string, alpha: number): string {
  const color = parseColor(value);
  return color ? colorToCss({ ...color, a: clamp(alpha) }) : value;
}

// OKLab, so a mix moves lightness evenly and keeps the hue: halfway from a
// saturated blue to white is a paler blue, not the greyed-out purple-blue
// that averaging sRGB channels gives. `crates/atlas-theme/src/color.rs` has
// the same maths, and the golden fixture (`base-derivation.json`) keeps the
// two agreeing to the last digit.

const toLinear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (value: number) =>
  255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);

function toOklab({ r, g, b }: RgbaColor): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: [number, number, number], alpha: number): RgbaColor {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), 0, 255),
    g: clamp(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), 0, 255),
    b: clamp(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), 0, 255),
    a: alpha,
  };
}

/** `amount` of the way from `left` to `right`, in OKLab; alpha moves linearly. */
export function mix(left: string, right: string, amount: number): string {
  const a = parseColor(left);
  const b = parseColor(right);
  if (!a || !b) return left;
  const t = clamp(amount);
  const [x, y] = [toOklab(a), toOklab(b)];
  return colorToCss(
    fromOklab(
      [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t],
      a.a + (b.a - a.a) * t,
    ),
  );
}

/** WCAG 2 relative luminance, ignoring alpha. */
function luminance({ r, g, b }: RgbaColor): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2 contrast ratio, 1 to 21. Unreadable input answers 1. */
export function contrastRatio(left: string, right: string): number {
  const a = parseColor(left);
  const b = parseColor(right);
  if (!a || !b) return 1;
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Of `a` and `b`, the one that reads better on `surface`; `a` on a tie. */
export function readable(surface: string, a: string, b: string): string {
  return contrastRatio(surface, b) > contrastRatio(surface, a) ? b : a;
}

export function lighten(value: string, amount: number): string {
  return mix(value, "#ffffff", amount);
}

// ─── HSV, for the colour picker's plane and hue slider ──────────────────────
// HSV is what a saturation/brightness
// square is drawn in; nothing derives in it.

export interface HsvColor {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
}

/** Any colour `parseColor` reads, as HSV; black when it does not parse. */
export function toHsv(value: string): HsvColor {
  const color = parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const [red, green, blue] = [color.r / 255, color.g / 255, color.b / 255];
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = v - chroma;
  return colorToCss({
    r: (red + match) * 255,
    g: (green + match) * 255,
    b: (blue + match) * 255,
    a: 1,
  });
}
