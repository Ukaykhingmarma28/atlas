import { useCallback, useEffect, useState } from "react";
import { ChevronRight, RotateCcw, Settings } from "lucide-react";
import { ScrollArea } from "@/ui/scroll-area";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { LayoutsSettings } from "./layouts-settings";
import { SkillsAndPacks } from "./skills-and-packs";
import { AgentsPage } from "./agents/agents-page";
import { KeybindingsSettings } from "./keybindings-settings";
import { NotificationsSettings } from "./notifications-settings";
import { GeneralPage } from "./pages/general-page";
import { AppearancePage } from "./pages/appearance-page";
import { ChatPage } from "./pages/chat-page";
import { MemoryPage } from "./pages/memory-page";
import { AboutPage, PrivacyPage, SourceControlPage, UpdatesPage } from "./pages/other-pages";
import { SettingsSidebar } from "./settings-sidebar";
import {
  SETTINGS_SECTIONS,
  useSettingsNav,
  type SettingsSection,
} from "../stores/settings-nav-store";
import { useSettingsStore } from "../stores/settings-store";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/app-settings";
import {
  changedOnPage,
  sectionEntry,
  sectionLabel,
  type SearchItem,
} from "../lib/settings-sections";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";

/** The gap between the tab's edge and the card — the chat tab's value. */
const CARD_INSET = 4;

const NAV_COLLAPSED_KEY = "atlas:settings:navCollapsed";

/** Pages drawn with the settings layout, inside one scroll area. */
const PAGES: Partial<Record<SettingsSection, () => React.ReactElement>> = {
  general: () => <GeneralPage />,
  appearance: () => <AppearancePage />,
  chat: () => <ChatPage />,
  memory: () => <MemoryPage />,
  notifications: () => <NotificationsSettings />,
  keybindings: () => <KeybindingsSettings />,
  agents: () => <AgentsPage />,
  skills: () => <SkillsAndPacks />,
  "source-control": () => <SourceControlPage />,
  privacy: () => <PrivacyPage />,
  updates: () => <UpdatesPage />,
  layouts: () => <LayoutsSettings />,
  about: () => <AboutPage />,
};

const asSection = (value: string | undefined): SettingsSection =>
  (SETTINGS_SECTIONS as readonly string[]).includes(value ?? "")
    ? (value as SettingsSection)
    : "general";

export function SettingsPanel({ initialSection }: { initialSection?: string } = {}) {
  const [active, setActive] = useState<SettingsSection>(() => asSection(initialSection));

  // Honor cross-component "open Settings → <section>" requests (e.g. the
  // sidebar's Skills button), whether this panel is fresh or already mounted.
  const navSection = useSettingsNav((s) => s.section);
  const clearNav = useSettingsNav((s) => s.clear);
  const setShown = useSettingsNav((s) => s.setShown);
  const goTo = useSettingsNav((s) => s.goTo);
  useEffect(() => {
    setShown(active);
    return () => setShown(null);
  }, [active, setShown]);
  useEffect(() => {
    if (navSection) {
      setActive(navSection);
      clearNav();
    }
  }, [navSection, clearNav]);

  // Installed agents whose copy on disk is behind the registry. Background
  // prefetch clears most of these on its own; what is left (offline, npm
  // failing) is what needs the user's hand, so the nav says so.
  const agentUpdates = useAgentRegistryStore(
    (s) => s.registryEntries.filter((e) => e.installed && e.updateAvailable).length,
  );

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = useCallback(
    () =>
      setCollapsed((c) => {
        const next = !c;
        try {
          localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0");
        } catch {
          /* ignore */
        }
        return next;
      }),
    [],
  );

  const onSearchPick = (item: SearchItem) => goTo(item.section, item.anchor);

  const page = PAGES[active];

  return (
    // The chat, Timeline and terminal tabs' card: an inset on the tab's card
    // fill, the panel as a rounded card inside it, its edge carried by the
    // ring and the shadow only lifting it. The sidebar sits inside the card,
    // as the chat's session sidebar does. `overflow-hidden` is what makes the
    // corners real — the sidebar and the header hairlines paint to the edge.
    <div className="h-full min-h-0 bg-card" style={{ padding: CARD_INSET }}>
      <div className="flex h-full min-h-0 overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-border">
        <SettingsSidebar
          active={active}
          onSelect={setActive}
          onSearchPick={onSearchPick}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          badges={{ agents: agentUpdates }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <Breadcrumbs section={active} onHome={() => setActive("general")} />
            <RestoreDefaults section={active} />
          </header>
          <ScrollArea className="min-h-0 flex-1">{page?.()}</ScrollArea>
        </div>
      </div>
    </div>
  );
}

/**
 * Where you are: Settings, then the page, each with its sidebar icon. The
 * root is a way back to the first page; the current page is not a link.
 */
function Breadcrumbs({ section, onHome }: { section: SettingsSection; onHome: () => void }) {
  const entry = sectionEntry(section);
  const crumb = "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs leading-none";
  return (
    <nav aria-label="Breadcrumb" className="-ml-1.5 min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5">
        <li>
          <button
            type="button"
            onClick={onHome}
            className={cn(
              crumb,
              "text-muted-foreground transition-colors duration-fast ease-out-strong hover:bg-element-hover hover:text-foreground",
            )}
          >
            <Icon icon={Settings} size="sm" />
            Settings
          </button>
        </li>
        <li aria-hidden className="flex text-disabled">
          <Icon icon={ChevronRight} size="xs" />
        </li>
        <li aria-current="page" className={cn(crumb, "min-w-0 font-medium text-foreground")}>
          {entry && <Icon icon={entry.icon} size="sm" className="shrink-0" />}
          <span className="truncate">{sectionLabel(section)}</span>
        </li>
      </ol>
    </nav>
  );
}

/**
 * Put every setting on this page back to its default, after saying exactly
 * which ones will change. Shown only while at least one differs.
 */
function RestoreDefaults({ section }: { section: SettingsSection }) {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const [open, setOpen] = useState(false);
  const changed = changedOnPage(section, settings);
  if (changed.length === 0) return null;
  const restore = () => {
    const patch: Partial<AppSettings> = {};
    for (const meta of changed) {
      (patch as Record<string, unknown>)[meta.key] = DEFAULT_SETTINGS[meta.key];
    }
    void updateSettings(patch);
    setOpen(false);
  };
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Icon icon={RotateCcw} size="sm" />
        Restore defaults
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Restore {sectionLabel(section)} defaults?</DialogTitle>
            <DialogDescription>
              {changed.length === 1
                ? "This setting goes back to its default."
                : `These ${changed.length} settings go back to their defaults.`}{" "}
              Nothing on other pages changes.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1 rounded-md border border-border-subtle p-2">
            {changed.map((meta) => (
              <li key={meta.key} className="text-2xs text-secondary-foreground">
                {meta.section} › {meta.title}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button onClick={restore}>Restore defaults</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
