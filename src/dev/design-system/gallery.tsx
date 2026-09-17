import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { describeDerivation, THEME_KEY_REGISTRY } from "@/features/theme/theme-key-registry";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import type { ThemeMode } from "@/features/theme/lib/theme-api";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Icon, ICON_SIZES, type IconSize } from "@/ui/icon";
import { Input } from "@/ui/input";
import { Kbd, KbdCombo } from "@/ui/kbd";
import { cn } from "@/lib/utils";
import {
  BASE_COLOR_TOKENS,
  CONTROL_HEIGHTS,
  DURATIONS,
  EASINGS,
  ELEVATIONS,
  LAYOUT_CONSTANTS,
  RADII,
  TEXT_STYLES,
  TYPE_SCALE,
  Z_LAYERS,
} from "./tokens";

/**
 * The design-system gallery (decision 21).
 *
 * Dev-only, reached at `localhost:1420/?scenario=design-system`. It renders
 * every Foundations token and every `src/ui` primitive against the ACTIVE
 * theme, which makes it the one page a visual review opens: pick a theme in
 * the header and every section below repaints.
 *
 * Values are read back with `getComputedStyle` rather than printed from a
 * table, so a token that stops resolving shows up here as an empty cell
 * instead of a number that is only true in this file.
 */

// ── plumbing ────────────────────────────────────────────────────────────────

/** Re-read on every theme application, so the printed values track the theme. */
function useCssValues(names: readonly string[]): Record<string, string> {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("atlas:theme-applied", bump);
    return () => window.removeEventListener("atlas:theme-applied", bump);
  }, []);
  return useMemo(() => {
    void tick;
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
  }, [names, tick]);
}

function Section({
  title,
  decision,
  note,
  children,
}: {
  title: string;
  decision: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border-subtle py-8">
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="heading">{title}</h2>
        <span className="caption">{decision}</span>
      </div>
      {note ? <p className="caption mb-4 max-w-2xl">{note}</p> : null}
      {children}
    </section>
  );
}

function Row({ name, value, children }: { name: string; value?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-1.5">
      <code className="code w-44 shrink-0 text-text-secondary">{name}</code>
      <code className="code w-28 shrink-0 text-text-tertiary">{value ?? ""}</code>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ── colour ──────────────────────────────────────────────────────────────────

function Swatch({
  cssVar,
  label,
  value,
  derivation,
}: {
  cssVar: string;
  label: string;
  value?: string;
  derivation?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div
        className="size-control-md shrink-0 rounded border border-border-default"
        style={{ background: `var(${cssVar})` }}
      />
      <div className="min-w-0">
        <div className="code truncate text-text-primary">{label}</div>
        <div className="caption truncate" title={derivation}>
          {value || "—"}
          {derivation ? ` · ${derivation}` : ""}
        </div>
      </div>
    </div>
  );
}

const COLOUR_VARS = [
  ...BASE_COLOR_TOKENS.map((token) => `--${token}`),
  ...THEME_KEY_REGISTRY.map((definition) => definition.cssVar as string),
];

function ColourSections() {
  const values = useCssValues(COLOUR_VARS);
  const groups = useMemo(() => {
    const byPrefix = new Map<string, (typeof THEME_KEY_REGISTRY)[number][]>();
    for (const definition of THEME_KEY_REGISTRY) {
      const prefix = definition.key.split(".")[0];
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), definition]);
    }
    return [...byPrefix.entries()];
  }, []);

  return (
    <>
      <Section
        title="Base tokens"
        decision="decision 2 · shadcn names, verbatim"
        note="The required level of a theme file. Everything else in Atlas derives from these."
      >
        <div className="grid grid-cols-2 gap-x-6 md:grid-cols-4">
          {BASE_COLOR_TOKENS.map((token) => (
            <Swatch key={token} cssVar={`--${token}`} label={token} value={values[`--${token}`]} />
          ))}
        </div>
      </Section>

      {groups.map(([prefix, definitions]) => (
        <Section
          key={prefix}
          title={`Theme keys · ${prefix}`}
          decision={`${definitions.length} keys`}
        >
          <div className="grid grid-cols-2 gap-x-6 md:grid-cols-3">
            {definitions.map((definition) => (
              <Swatch
                key={definition.key}
                cssVar={definition.cssVar}
                label={definition.key}
                value={values[definition.cssVar]}
                derivation={describeDerivation(definition)}
              />
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}

// ── the rest of the scales ──────────────────────────────────────────────────

const TYPE_VARS = TYPE_SCALE.map((s) => `--text-${s.name}`);
const CONTROL_VARS = [
  ...CONTROL_HEIGHTS.map((c) => c.cssVar),
  ...LAYOUT_CONSTANTS.map((l) => l.cssVar),
];
const RADIUS_VARS = ["--radius", ...RADII.map((r) => r.cssVar)];
const ELEVATION_VARS = ELEVATIONS.map((e) => e.cssVar);
const Z_VARS = Z_LAYERS.map((z) => z.cssVar);
const DURATION_VARS = DURATIONS.map((d) => d.cssVar);

function TypeSection() {
  const values = useCssValues(TYPE_VARS);
  return (
    <>
      <Section
        title="Type scale"
        decision="decision 24"
        note="Nine steps. Half-pixel sizes round up. Only two weights exist: 500 (font-medium) and 600 (font-semibold)."
      >
        {TYPE_SCALE.map((step) => (
          <Row key={step.name} name={step.utility} value={values[`--text-${step.name}`]}>
            <span className={cn(step.utility, "font-medium text-text-primary")}>
              Atlas renders dense chrome at {step.px}px
            </span>
          </Row>
        ))}
        <div className="mt-4 flex items-center gap-6">
          <span className="body font-medium">font-medium · 500</span>
          <span className="body font-semibold">font-semibold · 600</span>
        </div>
      </Section>

      <Section
        title="Named text styles"
        decision="decision 24"
        note="Reach for one of these before reaching for a size plus a weight plus a colour."
      >
        {TEXT_STYLES.map((style) => (
          <Row key={style.utility} name={style.utility}>
            <div className="flex items-baseline gap-3">
              <span className={style.utility}>The quick brown fox</span>
              <span className="caption">{style.use}</span>
            </div>
          </Row>
        ))}
      </Section>
    </>
  );
}

function ControlHeightSection() {
  const values = useCssValues(CONTROL_VARS);
  return (
    <Section
      title="Control heights"
      decision="decision 25"
      note="Four steps. The heights the audit found at 22, 28 and 30 snap to the nearest one. The titlebar and the centre tab strip are named layout constants, not controls."
    >
      {CONTROL_HEIGHTS.map((height) => (
        <Row key={height.name} name={height.utility} value={values[height.cssVar]}>
          <div className="flex items-center gap-3">
            <div
              className={cn(
                height.utility,
                "w-40 rounded border border-border-default bg-bg-elevated",
              )}
            />
            <span className="caption">{height.use}</span>
          </div>
        </Row>
      ))}
      {LAYOUT_CONSTANTS.map((constant) => (
        <Row key={constant.name} name={constant.utility} value={values[constant.cssVar]}>
          <div
            className={cn(
              constant.utility,
              "w-40 rounded border border-dashed border-border-default",
            )}
          />
        </Row>
      ))}
    </Section>
  );
}

function RadiusSection() {
  const values = useCssValues(RADIUS_VARS);
  return (
    <Section
      title="Radius"
      decision="decision 26"
      note={`Derived from the theme's --radius (${values["--radius"] || "—"}): sm = r−4, md = r−2, lg = r, xl = r+4. A theme moves the whole scale by moving one number.`}
    >
      <div className="flex flex-wrap gap-6">
        {RADII.map((radius) => (
          <div key={radius.name} className="w-44">
            <div
              className={cn(
                radius.name,
                "mb-2 h-16 w-full border border-border-default bg-bg-elevated",
              )}
            />
            <div className="code text-text-secondary">{radius.name}</div>
            <div className="caption">{values[radius.cssVar] || "—"}</div>
            <div className="caption">{radius.use}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ElevationSection() {
  const values = useCssValues(ELEVATION_VARS);
  return (
    <Section
      title="Elevation"
      decision="decision 27"
      note="Three levels; the shadow colour comes from the theme. inset-highlight is the 1px top edge on raised glass, and it composes with a shadow rather than replacing it."
    >
      <div className="flex flex-wrap gap-6">
        {ELEVATIONS.map((elevation) => (
          <div key={elevation.utility} className="w-56">
            <div
              className={cn(
                elevation.utility,
                "mb-2 flex h-20 items-center justify-center rounded-md bg-bg-elevated",
              )}
            >
              <span className="code text-text-secondary">{elevation.utility}</span>
            </div>
            <div className="caption truncate" title={values[elevation.cssVar]}>
              {values[elevation.cssVar] || "—"}
            </div>
            <div className="caption">{elevation.use}</div>
          </div>
        ))}
        <div className="w-56">
          <div className="inset-highlight mb-2 flex h-20 items-center justify-center rounded-md bg-bg-elevated">
            <span className="code text-text-secondary">inset-highlight</span>
          </div>
          <div className="caption">The white top edge.</div>
        </div>
        <div className="w-56">
          <div className="backdrop-blur-glass mb-2 flex h-20 items-center justify-center rounded-md border border-border-default">
            <span className="code text-text-secondary">backdrop-blur-glass</span>
          </div>
          <div className="caption">The one glass blur.</div>
        </div>
      </div>
    </Section>
  );
}

function ZIndexSection() {
  const values = useCssValues(Z_VARS);
  return (
    <Section
      title="Z-index layers"
      decision="decision 28"
      note="popover sits ABOVE modal on purpose, so a menu opened inside a dialog is not clipped behind it. Nothing outside globals.css writes a z-index."
    >
      <div className="flex gap-8">
        <div className="flex-1">
          {Z_LAYERS.map((layer) => (
            <Row key={layer.name} name={layer.utility} value={values[layer.cssVar]}>
              <div
                className="h-1 rounded-full bg-primary"
                style={{ width: `${Math.min(100, Number(values[layer.cssVar] || 0) / 5 + 6)}%` }}
              />
            </Row>
          ))}
        </div>
        <div className="relative h-40 w-64 shrink-0">
          {Z_LAYERS.map((layer, i) => (
            <div
              key={layer.name}
              className={cn(
                layer.utility,
                "absolute flex h-8 w-40 items-center rounded-md border border-border-default bg-bg-elevated px-2 shadow-md",
              )}
              style={{ top: i * 14, left: i * 12 }}
            >
              <span className="code text-text-secondary">{layer.name}</span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function MotionSection() {
  const values = useCssValues(DURATION_VARS);
  const [on, setOn] = useState(false);
  return (
    <Section
      title="Motion"
      decision="decision 29"
      note="Four durations and exactly three easing curves. src/ui/tooltip-timing.ts is the model for a component specifying its own motion on top of these."
    >
      <Button size="sm" variant="outline" onClick={() => setOn((v) => !v)} className="mb-4">
        Play
      </Button>
      {DURATIONS.map((duration) => (
        <Row key={duration.name} name={duration.utility} value={values[duration.cssVar]}>
          <div className="h-6 rounded bg-bg-elevated">
            <div
              className={cn(
                duration.utility,
                "ease-out-strong h-6 w-6 rounded bg-primary transition-transform",
              )}
              style={{ transform: on ? "translateX(220px)" : "translateX(0)" }}
            />
          </div>
        </Row>
      ))}
      {EASINGS.map((easing) => (
        <Row key={easing.name} name={easing.name}>
          <div className="flex items-center gap-3">
            <div className="h-6 flex-1 rounded bg-bg-elevated">
              <div
                className={cn(
                  easing.name,
                  "duration-slow h-6 w-6 rounded bg-text-tertiary transition-transform",
                )}
                style={{ transform: on ? "translateX(220px)" : "translateX(0)" }}
              />
            </div>
            <span className="caption w-56 shrink-0">{easing.use}</span>
          </div>
        </Row>
      ))}
    </Section>
  );
}

function IconSection() {
  const sizes = Object.keys(ICON_SIZES) as IconSize[];
  return (
    <Section
      title="Icons"
      decision="decision 30"
      note="Five sizes, one stroke width (1.75). The sweep maps the old numbers onto them: 9 → 10, 11 → 12, 13 → 14."
    >
      <div className="flex items-end gap-8">
        {sizes.map((size) => (
          <div key={size} className="flex flex-col items-center gap-2">
            <Icon icon={Search} size={size} className="text-text-primary" />
            <span className="code text-text-secondary">{size}</span>
            <span className="caption">{ICON_SIZES[size]}px</span>
          </div>
        ))}
        <div className="flex items-center gap-3">
          {[Settings, Plus, Trash2, ChevronRight, Check, Copy, X].map((glyph, i) => (
            <Icon key={i} icon={glyph} size="md" className="text-text-tertiary" />
          ))}
        </div>
      </div>
    </Section>
  );
}

function StateSection() {
  return (
    <Section
      title="Focus and disabled"
      decision="decision 31"
      note="Tab through the row below: every focusable element draws the same 2px --ring outline on :focus-visible, and nothing draws one on a mouse click. Disabled is opacity-50 plus cursor-not-allowed, everywhere."
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button size="sm">Focusable</Button>
        <Button size="sm" variant="outline">
          Focusable
        </Button>
        <IconButton icon={Settings} label="Settings" size="sm" variant="outline" />
        <Input size="sm" placeholder="Focusable field" className="w-48" />
        <button
          type="button"
          className="focus-ring-none rounded border border-border-default px-2 py-1 text-xs text-text-secondary"
        >
          focus-ring-none (opts out)
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled>
          Disabled
        </Button>
        <Button size="sm" variant="outline" disabled>
          Disabled
        </Button>
        <IconButton icon={Trash2} label="Delete" size="sm" variant="outline" disabled />
        <Input size="sm" placeholder="Disabled field" className="w-48" disabled />
        <span className="disabled-look label">disabled-look (non-control)</span>
      </div>
    </Section>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────

const BUTTON_VARIANTS = [
  "default",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
] as const;
const BUTTON_SIZES = ["xs", "sm", "md", "lg"] as const;
const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "destructive",
  "success",
  "warning",
  "info",
] as const;

function PrimitiveSection() {
  return (
    <>
      <Section
        title="Button"
        decision="decision 32 · src/ui/button.tsx"
        note="Six variants × four sizes, sized on the control heights. Shaped like shadcn's base-style Button so later `shadcn add` output drops in; it has no asChild, because that would need a second new dependency."
      >
        {BUTTON_SIZES.map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} size={size} variant={variant}>
                  {variant}
                </Button>
              ))}
              <Button size={size} variant="outline">
                <Icon icon={Plus} size="sm" />
                with icon
              </Button>
            </div>
          </Row>
        ))}
      </Section>

      <Section
        title="IconButton"
        decision="decision 32 · src/ui/icon-button.tsx"
        note="Square, and its `label` is required — an icon-only control has no visible name. The glyph is one step below the square."
      >
        {BUTTON_SIZES.map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              {(["default", "destructive", "outline", "secondary", "ghost"] as const).map(
                (variant) => (
                  <IconButton
                    key={variant}
                    icon={Settings}
                    label={`${variant} settings`}
                    size={size}
                    variant={variant}
                  />
                ),
              )}
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Input" decision="decision 32 · src/ui/input.tsx">
        {BUTTON_SIZES.map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              <Input size={size} placeholder="Placeholder" className="w-48" />
              <Input size={size} defaultValue="With a value" className="w-48" />
              <Input size={size} defaultValue="Invalid" aria-invalid className="w-32" />
            </div>
          </Row>
        ))}
      </Section>

      <Section
        title="Badge"
        decision="decision 32 · src/ui/badge.tsx"
        note="Not a control, so not on the control-height scale. Status colour comes from the theme's status tokens."
      >
        {(["md", "sm"] as const).map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              {BADGE_VARIANTS.map((variant) => (
                <Badge key={variant} size={size} variant={variant}>
                  {variant}
                </Badge>
              ))}
              <Badge size={size} variant="success">
                <Icon icon={Check} size="xs" />
                with icon
              </Badge>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Kbd" decision="decision 32 · src/ui/kbd.tsx">
        <Row name={`size="xs"`}>
          <div className="flex items-center gap-3">
            <KbdCombo combo="⌘⇧F" />
            <Kbd>Esc</Kbd>
            <Kbd>⏎</Kbd>
          </div>
        </Row>
        <Row name={`size="sm"`}>
          <div className="flex items-center gap-3">
            <Kbd size="sm">⌘</Kbd>
            <Kbd size="sm">K</Kbd>
          </div>
        </Row>
      </Section>
    </>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

const MODES: ThemeMode[] = ["system", "dark", "light"];

function Header() {
  const themes = useThemeStore.use.themes();
  const actions = useThemeStore.use.actions();
  const [themeId, setThemeId] = useState("atlas");
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    void actions.load();
  }, [actions]);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current) setThemeId(current);
  }, []);

  const apply = (id: string, nextMode: ThemeMode) => {
    setThemeId(id);
    setMode(nextMode);
    void actions.apply(id, nextMode);
  };

  return (
    <header className="z-titlebar sticky top-0 -mx-8 mb-2 flex items-center gap-3 border-b border-border-default bg-bg-base px-8 py-3 backdrop-blur-glass">
      <div>
        <div className="heading">Atlas design system</div>
        <div className="caption">
          Foundations · decisions 17–33 · {THEME_KEY_REGISTRY.length} theme keys
        </div>
      </div>
      <div className="flex-1" />
      <label className="label flex items-center gap-2">
        Theme
        <select
          className="h-control-md rounded border border-border-default bg-bg-input px-2 text-xs text-text-primary"
          value={themeId}
          onChange={(e) => apply(e.target.value, mode)}
        >
          {themes.length === 0 ? <option value={themeId}>{themeId}</option> : null}
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      <label className="label flex items-center gap-2">
        Mode
        <select
          className="h-control-md rounded border border-border-default bg-bg-input px-2 text-xs text-text-primary"
          value={mode}
          onChange={(e) => apply(themeId, e.target.value as ThemeMode)}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
    </header>
  );
}

export function DesignSystemGallery() {
  return (
    <div className="h-full overflow-y-auto bg-bg-base px-8 pb-24 text-text-primary">
      <Header />
      <TypeSection />
      <ControlHeightSection />
      <RadiusSection />
      <ElevationSection />
      <ZIndexSection />
      <MotionSection />
      <IconSection />
      <StateSection />
      <PrimitiveSection />
      <ColourSections />
    </div>
  );
}
