import { useEffect, useMemo, useState } from "react";
import { Download, Search, X } from "lucide-react";
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

// Light variants are loadable and persistable in schema 1, but the setting is
// intentionally hidden until PR 4 finishes the app-wide light appearance QA.
const ENABLE_LIGHT_MODE = false;

export function AtlasThemesSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useThemeStore.use.themes();
  const loading = useThemeStore.use.loading();
  const error = useThemeStore.use.error();
  const { load } = useThemeStore.use.actions();
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

  const modes: ThemeMode[] = ENABLE_LIGHT_MODE ? ["system", "dark", "light"] : ["system", "dark"];

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
        <Hint label="Convert a shadcn, Zed or VS Code theme">
          <Button size="xs" variant="outline" onClick={() => setImporting(true)}>
            <Icon icon={Download} size="xs" />
            Import
          </Button>
        </Hint>
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((theme) => {
            const selected = theme.id === settings.theme;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => {
                  updateSettings({ theme: theme.id });
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
                <div className="flex gap-1 text-[9px] uppercase tracking-wide text-text-muted">
                  {theme.hasDark && <span>Dark</span>}
                  {theme.hasLight && <span>Light</span>}
                  {!theme.builtIn && <span>Local</span>}
                </div>
              </button>
            );
          })}
        </div>

        {loading && <div className="py-6 text-center text-[11px] text-text-tertiary">Loading…</div>}
        {error && <div className="py-6 text-center text-[11px] text-status-error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-6 text-center text-[11px] text-text-tertiary">
            No themes match “{query}”.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
