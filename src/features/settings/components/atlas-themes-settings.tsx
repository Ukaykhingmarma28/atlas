import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { ScrollArea } from "@/ui/scroll-area";
import { LIGHT_APPEARANCE_ENABLED } from "@/features/theme/apply-theme";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import type { ThemeMode } from "@/features/theme/lib/theme-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

export function AtlasThemesSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useThemeStore.use.themes();
  const skipped = useThemeStore.use.skipped();
  const loading = useThemeStore.use.loading();
  const error = useThemeStore.use.error();
  const { load, reapply } = useThemeStore.use.actions();
  const [query, setQuery] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return themes;
    return themes.filter(
      (theme) => theme.name.toLowerCase().includes(q) || theme.author.toLowerCase().includes(q),
    );
  }, [query, themes]);

  // Light variants are loadable and persistable in schema 1; the button
  // appears when `LIGHT_APPEARANCE_ENABLED` does, which is also what stops
  // `system` resolving to light in the meantime.
  const modes: ThemeMode[] = LIGHT_APPEARANCE_ENABLED
    ? ["system", "dark", "light"]
    : ["system", "dark"];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[36px] shrink-0 items-center justify-between gap-3 border-b border-border-default bg-bg-primary px-3">
        <span className="text-[11px] font-medium text-text-secondary">Mode</span>
        <div className="flex rounded-md border border-border-default bg-bg-secondary p-0.5">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => updateSettings({ themeMode: mode })}
              className={cn(
                "rounded px-2 py-1 text-[10px] capitalize transition-colors",
                settings.themeMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-text-tertiary hover:text-text-primary",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search themes…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {query && (
          <Hint label="Clear search">
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 cursor-pointer text-text-tertiary hover:text-text-primary"
            >
              <X size={11} />
            </button>
          </Hint>
        )}
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
              <span className="text-xs font-medium text-text-primary">
                {skipped.length === 1
                  ? "1 theme file was skipped"
                  : `${skipped.length} theme files were skipped`}
              </span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {skipped.map((warning) => (
                <li key={warning.key} className="text-2xs leading-snug text-text-tertiary">
                  <span className="font-medium text-text-secondary">{warning.key}</span> —{" "}
                  {warning.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {filtered.map((theme) => {
            const selected = theme.id === settings.theme;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => {
                  // Clicking the theme you are already on writes the same id
                  // back, and `applySettingsSideEffects` — rightly — skips a
                  // value that did not change. That made the obvious way to
                  // pick up a hand-edit ("click it again") do nothing at all,
                  // so ask the theme store directly instead.
                  if (selected) void reapply();
                  else updateSettings({ theme: theme.id });
                  toast.success(`Applied “${theme.name}” theme`);
                }}
                className={cn(
                  "flex min-h-24 flex-col justify-between rounded-lg border bg-bg-secondary p-3 text-left transition-colors",
                  selected ? "border-primary" : "border-border-default hover:border-border-strong",
                )}
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-text-primary">
                      {theme.name}
                    </span>
                    {selected && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  </div>
                  <p className="mt-1 text-[10.5px] text-text-tertiary">{theme.author}</p>
                </div>
                <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-text-muted">
                  {theme.hasDark && <span>Dark</span>}
                  {theme.hasLight && <span>Light</span>}
                  {!theme.builtIn && <span>Local</span>}
                  {/* A theme that loaded but carries keys Atlas does not know.
                      Those keys are preserved, not applied, so the author sees
                      the name they typed do nothing until they are told. */}
                  {theme.warnings.length > 0 && (
                    <Hint
                      label={
                        <span className="block max-w-64 whitespace-pre-line text-left">
                          {theme.warnings
                            .map((warning) => `${warning.key}: ${warning.message}`)
                            .join("\n")}
                        </span>
                      }
                    >
                      <span
                        aria-label={`${theme.warnings.length} unknown theme key(s)`}
                        className="ml-auto flex items-center gap-1 text-warning"
                      >
                        <AlertTriangle size={9} />
                        {theme.warnings.length}
                      </span>
                    </Hint>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {loading && <div className="py-6 text-center text-[11px] text-text-tertiary">Loading…</div>}
        {error && <div className="py-6 text-center text-[11px] text-error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-6 text-center text-[11px] text-text-tertiary">
            No themes match “{query}”.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
