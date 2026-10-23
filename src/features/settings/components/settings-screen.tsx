import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ScrollArea } from "@/ui/scroll-area";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { WindowControls, useWindowDrag } from "@/components/titlebar";
import { isLinux, isWindows } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { closeSettings } from "../lib/open-settings";
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
import { useSettingsNav, type SettingsSection } from "../stores/settings-nav-store";
import { useSettingsStore } from "../stores/settings-store";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/app-settings";
import { changedOnPage, sectionLabel, type SearchItem } from "../lib/settings-sections";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";

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

/**
 * Settings, covering the whole window: its own sidebar
 * under the traffic lights, `Settings / <page>` in the bar, and `Back` to the
 * workspace.
 *
 * `AppLayout` mounts it on first open and from then on it is only hidden, so the open page, its
 * sub-tabs and any half-typed field survive a trip back to the workspace. The
 * workspace stays mounted underneath for the same reason — terminals, chats
 * and editors are exactly as they were.
 */
export function SettingsScreen() {
  const open = useSettingsNav((s) => s.open);
  return (
    <div
      className={cn("fixed inset-0 z-drawer flex bg-background", !open && "hidden")}
      aria-hidden={!open}
    >
      <SettingsBody open={open} />
    </div>
  );
}

function SettingsBody({ open }: { open: boolean }) {
  const [active, setActive] = useState<SettingsSection>(
    () => useSettingsNav.getState().section ?? "general",
  );

  // Honor "open Settings → <section>" requests from anywhere (the account
  // menu, a notification, `ui_open`), whether the screen is fresh or up.
  const navSection = useSettingsNav((s) => s.section);
  const clearNav = useSettingsNav((s) => s.clear);
  const setShown = useSettingsNav((s) => s.setShown);
  const goTo = useSettingsNav((s) => s.goTo);
  useEffect(() => {
    if (!open) return;
    setShown(active);
    return () => setShown(null);
  }, [open, active, setShown]);
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

  const onSearchPick = (item: SearchItem) => goTo(item.section, item.anchor);
  const drag = useWindowDrag();
  const page = PAGES[active];

  return (
    <>
      <SettingsSidebar
        active={active}
        onSelect={setActive}
        onSearchPick={onSearchPick}
        onBack={closeSettings}
        badges={{ agents: agentUpdates }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          {...drag}
          className={cn(
            "flex h-titlebar shrink-0 select-none items-center gap-3 pl-4",
            isWindows || isLinux ? "pr-0" : "pr-3",
          )}
        >
          <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Settings</span>
            <span className="text-disabled">/</span>
            <span className="truncate text-foreground">{sectionLabel(active)}</span>
          </p>
          <RestoreDefaults section={active} />
          {(isWindows || isLinux) && <WindowControls />}
        </header>
        <ScrollArea className="min-h-0 flex-1">{page?.()}</ScrollArea>
      </div>
    </>
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
