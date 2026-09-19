import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { Hint } from "@/ui/tooltip";
import { ScrollArea } from "@/ui/scroll-area";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import { appearanceForMode } from "@/features/theme/apply-theme";
import { previewTheme, type ThemePreview } from "@/features/theme/preview-theme";
import { ThemeMiniature } from "@/features/theme/components/theme-miniature";
import type {
  Theme,
  ThemeAppearance,
  ThemeMode,
  ThemeSummary,
} from "@/features/theme/lib/theme-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { ThemeImportPanel } from "./theme-import-panel";

// All three, since the app-wide light pass is done. A theme with no light
// variant still resolves — `resolveTheme` falls back to its other variant,
// which is the documented schema-1 behaviour and is why picking Light with a
// dark-only theme selected is not an error state.
const MODES = [
  { mode: "system", label: "System", icon: Monitor },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "light", label: "Light", icon: Sun },
] as const satisfies readonly { mode: ThemeMode; label: string; icon: typeof Monitor }[];

/**
 * Segmented System / Dark / Light control. One thumb slides under the equal-width
 * segments instead of each segment swapping its own background, so a change reads
 * as movement rather than a flicker. Arrow keys move the selection, as they do
 * in any native radio group.
 */
function ModeSwitch({
  value,
  systemAppearance,
  onChange,
}: {
  value: ThemeMode;
  systemAppearance: ThemeAppearance;
  onChange: (mode: ThemeMode) => void;
}) {
  const index = Math.max(
    0,
    MODES.findIndex((m) => m.mode === value),
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + MODES.length) % MODES.length;
    onChange(MODES[next].mode);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Appearance mode"
      onKeyDown={onKeyDown}
      className="relative grid shrink-0 grid-cols-3 rounded-full border border-border bg-card p-0.5"
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-full bg-element-selected ring-1 ring-border transition-transform duration-200 ease-out-strong motion-reduce:transition-none"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {MODES.map(({ mode, label, icon }) => {
        const active = value === mode;
        const button = (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(mode)}
            className={cn(
              "relative z-10 flex h-control-xs cursor-pointer items-center justify-center gap-1 rounded-full px-2.5 text-2xs font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              active ? "text-foreground" : "text-muted-foreground hover:text-secondary-foreground",
            )}
          >
            <Icon icon={icon} size="xs" />
            {/* Icon-only when the toolbar is narrow: three labelled segments
                are ~200px, and below that the labels overlap each other. */}
            <span className="hidden @lg:inline">{label}</span>
          </button>
        );
        return mode === "system" ? (
          <Hint key={mode} label={`Follow the OS — currently ${systemAppearance}`}>
            {button}
          </Hint>
        ) : (
          button
        );
      })}
    </div>
  );
}

export function AtlasThemesSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useThemeStore.use.themes();
  const loaded = useThemeStore.use.loaded();
  const skipped = useThemeStore.use.skipped();
  const loading = useThemeStore.use.loading();
  const error = useThemeStore.use.error();
  const { load, loadAll, reapply } = useThemeStore.use.actions();
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  /** Per-card appearance override — see `AppearanceSwatch`. */
  const [previewing, setPreviewing] = useState<Record<string, ThemeAppearance>>({});

  useEffect(() => {
    void load();
  }, [load]);

  // Every card resolves a full theme document, and the catalog only carries
  // summaries. Keyed on `themes` rather than run once, so the batch re-runs
  // after the file watcher drops the cache; `loadAll` skips what it already has.
  useEffect(() => {
    void loadAll();
  }, [loadAll, themes]);

  /** What the user would actually get if they clicked a card right now. */
  const appearance = appearanceForMode(settings.themeMode);

  // Both stable, because `ThemeCard` is memoised: a card whose props did not
  // change must not re-render, and a fresh closure per card per keystroke
  // would change one on every card of every render.
  const onPreview = useCallback((id: string, next: ThemeAppearance) => {
    setPreviewing((state) => ({ ...state, [id]: next }));
  }, []);

  const onApply = useCallback(
    (id: string, name: string) => {
      // Clicking the theme you are already on writes the same id back, and
      // `applySettingsSideEffects` — rightly — skips a value that did not
      // change. That made the obvious way to pick up a hand-edit ("click it
      // again") do nothing at all, so ask the theme store directly instead.
      if (id === settings.theme) void reapply();
      else updateSettings({ theme: id });
      toast.success(`Applied “${name}” theme`);
    },
    [settings.theme, reapply, updateSettings],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return themes;
    return themes.filter(
      (theme) => theme.name.toLowerCase().includes(q) || theme.author.toLowerCase().includes(q),
    );
  }, [query, themes]);

  // The import panel replaces the grid rather than floating over it: it is a
  // multi-step, scrolling surface (paste, convert, read the report, name the
  // theme) and a dialog would fight the settings pane for height.
  if (importing) {
    return (
      <ThemeImportPanel
        themes={themes}
        onClose={() => setImporting(false)}
        onImported={(id) => {
          // The watcher will re-list the catalog; applying it here is what
          // makes the import visibly land.
          updateSettings({ theme: id });
          void load();
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One toolbar: filter the catalog, pick the mode, import a new theme.
          A container, so the mode switch can drop its labels on a narrow pane;
          narrower still, it wraps rather than squeezing the search to nothing. */}
      <div className="@container flex min-h-[36px] shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border bg-background px-3 py-1">
        <Search size={11} className="shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search themes…"
          spellCheck={false}
          className="min-w-20 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <Hint label="Clear search">
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <X size={11} />
            </button>
          </Hint>
        )}
        <ModeSwitch
          value={settings.themeMode}
          systemAppearance={appearanceForMode("system")}
          onChange={(mode) => updateSettings({ themeMode: mode })}
        />
        <Hint label="Convert a shadcn, Zed or VS Code theme">
          <Button size="xs" variant="outline" onClick={() => setImporting(true)}>
            <Icon icon={Download} size="xs" />
            Import
          </Button>
        </Hint>
      </div>

      <ScrollArea className="flex-1 p-2">
        {/* A file Rust could not load is skipped rather than fatal, which is
            what keeps the catalog alive — but it also means the theme you
            just saved simply never appears, with no clue why. Silent on a
            healthy install; the whole point on a broken one. */}
        {skipped.length > 0 && (
          <div className="mb-2 rounded-lg border border-warning/40 bg-warning-muted p-2.5">
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={11} className="shrink-0 text-warning" />
              <span className="text-xs font-medium text-foreground">
                {skipped.length === 1
                  ? "1 theme file was skipped"
                  : `${skipped.length} theme files were skipped`}
              </span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {skipped.map((warning) => (
                <li key={warning.key} className="text-2xs leading-snug text-muted-foreground">
                  <span className="font-medium text-secondary-foreground">{warning.key}</span> —{" "}
                  {warning.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {filtered.map((theme) => (
            <ThemeCard
              key={theme.id}
              summary={theme}
              full={loaded[theme.id]}
              selected={theme.id === settings.theme}
              appearance={previewing[theme.id] ?? appearance}
              onPreview={onPreview}
              onApply={onApply}
            />
          ))}
        </div>

        {loading && <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>}
        {error && <div className="py-6 text-center text-xs text-error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No themes match “{query}”.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * One theme in the grid: a live preview of the theme, the name, and the
 * dark/light affordance.
 *
 * The card's OWN chrome — the selected border, the card surface, the name —
 * stays on the active theme; only `ThemeMiniature` carries the previewed
 * theme's variables, so nothing here has to be applied to be seen.
 *
 * Memoised, because a miniature is ~40 elements and 124 inline custom
 * properties: resolving a theme is free once cached, but reconciling fifteen
 * of these on every search keystroke is not. Every prop is stable — the
 * summaries come from the store, the documents from its `loaded` map, and the
 * two callbacks are `useCallback`ed above — so a keystroke only pays for the
 * cards that actually appear or disappear.
 */
const ThemeCard = memo(function ThemeCard({
  summary,
  full,
  selected,
  appearance,
  onPreview,
  onApply,
}: {
  summary: ThemeSummary;
  /** `undefined` until `loadAll` has the document. */
  full: Theme | undefined;
  selected: boolean;
  appearance: ThemeAppearance;
  onPreview: (id: string, appearance: ThemeAppearance) => void;
  onApply: (id: string, name: string) => void;
}) {
  const preview = full ? previewTheme(full, appearance) : null;
  const dark = full && summary.hasDark ? previewTheme(full, "dark") : null;
  const light = full && summary.hasLight ? previewTheme(full, "light") : null;

  return (
    <button
      type="button"
      onClick={() => onApply(summary.id, summary.name)}
      className={cn(
        "flex cursor-pointer flex-col overflow-hidden rounded-lg border text-left transition-colors",
        "bg-card",
        selected ? "border-primary" : "border-border hover:border-border-strong",
      )}
    >
      {preview ? (
        <ThemeMiniature preview={preview} />
      ) : (
        // The document is one `get_theme` away, not a failure state. A flat
        // block of the right height keeps the grid from reflowing when it lands.
        <div className="h-28 w-full shrink-0 bg-element-selected" />
      )}

      <div className="flex w-full items-start gap-1.5 border-t border-border-subtle p-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{summary.name}</span>
            {selected && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{summary.author}</span>
            {!summary.builtIn && (
              <span className="shrink-0 text-3xs uppercase tracking-wide text-disabled">Local</span>
            )}
            {/* A theme that loaded but carries keys Atlas does not know. Those
                keys are preserved, not applied, so the author sees the name
                they typed do nothing until they are told. */}
            {summary.warnings.length > 0 && (
              <Hint
                label={
                  <span className="block max-w-64 whitespace-pre-line text-left">
                    {summary.warnings
                      .map((warning) => `${warning.key}: ${warning.message}`)
                      .join("\n")}
                  </span>
                }
              >
                <span
                  aria-label={`${summary.warnings.length} unknown theme key(s)`}
                  className="flex shrink-0 items-center gap-0.5 text-warning"
                >
                  <AlertTriangle size={9} />
                  {summary.warnings.length}
                </span>
              </Hint>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <AppearanceSwatch
            label="Dark"
            theme={summary.name}
            preview={dark}
            active={preview?.appearance === "dark"}
            onPick={() => onPreview(summary.id, "dark")}
          />
          <AppearanceSwatch
            label="Light"
            theme={summary.name}
            preview={light}
            active={preview?.appearance === "light"}
            onPick={() => onPreview(summary.id, "light")}
          />
        </div>
      </div>
    </button>
  );
});

/**
 * The "this theme also has a light variant" affordance, and the control that
 * swaps the miniature to it.
 *
 * Thirteen of the fifteen built-ins now ship both, and a card that previewed
 * only the appearance you happen to be in would hide half of what you are
 * choosing. So the two variants are always both on the card — each swatch is
 * painted in ITS OWN variant's background, foreground and brand colour, which
 * says "there is a light one, and it looks like this" without a click. The
 * miniature still opens on the appearance the current `themeMode` would give
 * you; clicking a swatch swaps it, for that card only, without applying
 * anything.
 *
 * A `<span role="button">` rather than a `<button>`: the whole card is already
 * the apply control, and a nested `<button>` is invalid inside it. Same shape
 * as the icon picker's remove control, including the `stopPropagation` that
 * keeps swapping the preview from also applying the theme.
 */
function AppearanceSwatch({
  label,
  theme,
  preview,
  active,
  onPick,
}: {
  label: string;
  theme: string;
  /** `null` when this theme has no such variant, or is not loaded yet. */
  preview: ThemePreview | null;
  active: boolean;
  onPick: () => void;
}) {
  if (!preview) return null;
  return (
    <Hint label={`Preview ${theme} in ${label.toLowerCase()}`}>
      <span
        role="button"
        tabIndex={0}
        aria-pressed={active}
        aria-label={`Preview ${theme} in ${label.toLowerCase()}`}
        onClick={(event) => {
          event.stopPropagation();
          onPick();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.currentTarget.click();
        }}
        style={{
          backgroundColor: preview.swatch.background,
          color: preview.swatch.foreground,
          // Never transparent: a dark variant's swatch is near-black on a
          // near-black card, and with no edge it simply vanished. Its own
          // foreground always contrasts with its own background — that is what
          // makes it a foreground — so the edge is legible in either variant,
          // and the brand colour is what marks the one being shown.
          borderColor: active ? preview.swatch.primary : preview.swatch.foreground,
        }}
        className={cn(
          "flex h-4 cursor-pointer items-center gap-0.5 rounded-sm border px-1",
          "text-3xs font-medium uppercase tracking-wide transition-opacity",
          active ? "opacity-100" : "opacity-60 hover:opacity-100",
        )}
      >
        <span className="size-1 rounded-full" style={{ backgroundColor: preview.swatch.primary }} />
        {label}
      </span>
    </Hint>
  );
}
