import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { Hint } from "@/ui/tooltip";
import { ScrollArea } from "@/ui/scroll-area";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import type { ThemeMode } from "@/features/theme/lib/theme-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { ThemeImportPanel } from "./theme-import-panel";

export function AtlasThemesSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useThemeStore.use.themes();
  const skipped = useThemeStore.use.skipped();
  const loading = useThemeStore.use.loading();
  const error = useThemeStore.use.error();
  const { load, reapply } = useThemeStore.use.actions();
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);

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

  // All three, since the app-wide light pass is done. A theme with no light
  // variant still resolves — `resolveTheme` falls back to its other variant,
  // which is the documented schema-1 behaviour and is why picking Light with a
  // dark-only theme selected is not an error state.
  const modes: ThemeMode[] = ["system", "dark", "light"];

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
      <div className="flex h-[36px] shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3">
        <span className="text-xs font-medium text-secondary-foreground">Mode</span>
        <div className="flex rounded-md border border-border bg-card p-0.5">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => updateSettings({ themeMode: mode })}
              className={cn(
                "rounded px-2 py-1 text-2xs capitalize transition-colors",
                settings.themeMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border bg-background px-3">
        <Search size={11} className="shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search themes…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
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
                  "flex min-h-24 flex-col justify-between rounded-lg border bg-card p-3 text-left transition-colors",
                  selected ? "border-primary" : "border-border hover:border-border-strong",
                )}
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground">
                      {theme.name}
                    </span>
                    {selected && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{theme.author}</p>
                </div>
                <div className="flex items-center gap-1 text-3xs uppercase tracking-wide text-text-muted">
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
