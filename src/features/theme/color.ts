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
  const h = ((hue % 360) + 360) / 360;
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
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const gamma = (value: number) =>
    255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
  return {
    r: clamp(gamma(linear[0]), 0, 255),
    g: clamp(gamma(linear[1]), 0, 255),
    b: clamp(gamma(linear[2]), 0, 255),
    a: 1,
  };
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

export function mix(left: string, right: string, amount: number): string {
  const a = parseColor(left);
  const b = parseColor(right);
  if (!a || !b) return left;
  const t = clamp(amount);
  return colorToCss({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  });
}

export function lighten(value: string, amount: number): string {
  return mix(value, "#ffffff", amount);
}
