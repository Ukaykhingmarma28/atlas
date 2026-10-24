// The sidebar's foot: the destinations as one row of icons, then help, the
// notification bell and the account.
//
// The destinations used to be a navigation block above the project list; they
// are icons here so the session list gets the height. Each toggles what it
// opens (back to the session when it is already on screen), and each lights
// while its view is the one showing. Team chat stays visible when it is
// locked, greyed, saying what unlocks it.

import { useEffect, useState, type ComponentProps } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDownToLine,
  Bell,
  BookOpen,
  GitBranch,
  Globe,
  HelpCircle,
  Info,
  Keyboard,
  MessageCircle,
  MessageCircleQuestion,
  MessagesSquare,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { DISCORD_URL, DOCS_URL, GITHUB_URL, SITE_URL, X_URL } from "@/lib/atlas-links";
import { GithubIcon } from "@/components/github-icon";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { IconButton } from "@/ui/icon-button";
import { AccountButton } from "@/features/auth/components/account-button";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { updater } from "@/features/updater/lib/updater-api";
import {
  hasUnread,
  useNotificationsStore,
} from "@/features/notifications/stores/notifications-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  DESTINATIONS,
  destinationShown,
  toggleDestination,
} from "@/features/layout/lib/destinations";
import { sourceControlShown, toggleSourceControl } from "@/features/layout/lib/source-control";
import { teamChatShown, toggleTeamChat } from "@/features/layout/lib/team-chat";
import { unlockHint, useTeamAccess } from "@/features/comms/lib/team-chat-access";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";

/** One destination: an icon that lights while its view is on screen. */
function DestinationButton({
  label,
  hint,
  active,
  locked,
  ...props
}: Omit<ComponentProps<typeof IconButton>, "label" | "size" | "variant"> & {
  label: string;
  /** The tooltip, when it says more than the label (a shortcut). */
  hint?: string;
  active?: boolean;
  /** What unlocks a destination this button cannot open yet. The button stays
   *  clickable (the click is the unlock, where there is one) and greyed. */
  locked?: string;
}) {
  return (
    <HintItem label={locked ?? hint ?? label}>
      <IconButton
        label={label}
        aria-label={label}
        size="sm"
        variant="ghost"
        active={active}
        aria-current={active ? "page" : undefined}
        aria-disabled={locked ? true : undefined}
        data-locked={locked ? "" : undefined}
        {...props}
      />
    </HintItem>
  );
}

const noop = () => {};

function DestinationRow() {
  const timelineOpen = useLayoutStore((s) => destinationShown(s, "artifacts"));
  const teamChatOpen = useLayoutStore(teamChatShown);
  const knowledgeOpen = useLayoutStore((s) => destinationShown(s, "knowledge"));
  const memoryOpen = useLayoutStore((s) => destinationShown(s, "memory"));
  const sourceControlOpen = useLayoutStore(sourceControlShown);
  const usageOpen = useLayoutStore((s) => destinationShown(s, "usage"));
  // Knowledge and source control belong to a project; without one open they
  // say so instead of opening a view with nothing in it.
  const hasProject = useAppStore((s) => !!s.currentProject);
  const teamAccess = useTeamAccess();
  const settingsKeys = useActionShortcut("app.settings")?.label;
  return (
    <HintGroup>
      <nav aria-label="Destinations" className="flex items-center justify-between px-1.5">
        <DestinationButton
          icon={DESTINATIONS.artifacts.icon}
          label="Timeline"
          active={timelineOpen}
          onClick={() => toggleDestination("artifacts")}
        />
        <DestinationButton
          icon={MessagesSquare}
          label="Team chat"
          active={teamChatOpen}
          locked={unlockHint(teamAccess, "team chat")}
          onClick={teamAccess.locked ? (teamAccess.unlock ?? noop) : toggleTeamChat}
        />
        <DestinationButton
          icon={BookOpen}
          label={hasProject ? "Knowledge" : "Open a project to open its knowledge base"}
          active={knowledgeOpen}
          disabled={!hasProject}
          onClick={() => toggleDestination("knowledge")}
        />
        <DestinationButton
          icon={DESTINATIONS.memory.icon}
          label="Memory"
          active={memoryOpen}
          onClick={() => toggleDestination("memory")}
        />
        <DestinationButton
          icon={GitBranch}
          label={hasProject ? "Source control" : "Open a project to see its source control"}
          active={sourceControlOpen}
          disabled={!hasProject}
          onClick={toggleSourceControl}
        />
        <DestinationButton
          icon={DESTINATIONS.usage.icon}
          label="Usage"
          active={usageOpen}
          onClick={() => toggleDestination("usage")}
        />
        <DestinationButton
          icon={Settings}
          label="Settings"
          hint={settingsKeys ? `Settings ${settingsKeys}` : undefined}
          onClick={() => openSettingsSection("general")}
        />
      </nav>
    </HintGroup>
  );
}

export function SidebarFooter() {
  return (
    <div className="relative z-panel flex shrink-0 flex-col gap-1 border-t border-border-subtle pt-1.5">
      <DestinationRow />
      <div className="flex h-control-lg shrink-0 items-center justify-between px-2">
        {/* Help on the left, the bell and the account on the right. The version
            and the update check are in the help menu; interface size is in the
            account menu, beside the theme. */}
        <HelpMenu />
        <div className="flex items-center gap-1">
          <NotificationsButton />
          <AccountButton menuSide="top" />
        </div>
      </div>
    </div>
  );
}

function HelpItem({
  icon,
  label,
  hint,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  /** Quiet text at the row's end, saying what the click does. */
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onClick={onSelect}
      className="flex h-control-md items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-[var(--muted-foreground)]">
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {hint && <span className="text-2xs text-[var(--muted-foreground)]">{hint}</span>}
    </DropdownMenu.Item>
  );
}

/** Opens the notification drawer; a dot while the active org has unread. */
function NotificationsButton() {
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const unread = useNotificationsStore((s) => hasUnread(s.items, activeOrgId));
  const { toggle } = useNotificationsStore.use.actions();
  return (
    <Hint label="Notifications" side="top">
      <span className="relative flex">
        <IconButton
          icon={Bell}
          label="Notifications"
          size="sm"
          variant="hairline"
          shape="round"
          onClick={() => toggle(activeOrgId)}
        />
        {unread && (
          <span className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-foreground" />
        )}
      </span>
    </Hint>
  );
}

/** Help, community and the app's own destinations — and, at the foot, the
 *  running version and the update check. */
function HelpMenu() {
  const version = useAppVersion();
  return (
    <DropdownMenu.Root>
      <Hint label="Help & community" side="top">
        <DropdownMenu.Trigger
          render={
            <IconButton
              icon={HelpCircle}
              label="Help and community"
              size="sm"
              variant="hairline"
              shape="round"
            />
          }
        />
      </Hint>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" side="top" sideOffset={6}>
          <DropdownMenu.Popup className="w-[212px] overflow-hidden rounded-xl border border-border-subtle bg-[var(--card)]/95 p-1 backdrop-blur-2xl shadow-md select-none">
            <HelpItem
              icon={<BookOpen size={12} />}
              label="Docs"
              onSelect={() => void openUrl(DOCS_URL)}
            />
            <HelpItem
              icon={<MessageCircleQuestion size={12} />}
              label="Send feedback"
              // The panel is non-modal and anchored bottom-right; `toggle` is what
              // the status-bar button uses, and the source tags the report.
              onSelect={() => useFeedbackStore.getState().actions.toggle("status-bar")}
            />
            <HelpItem
              icon={<Keyboard size={12} />}
              label="Keyboard shortcuts"
              onSelect={() => openSettingsSection("keybindings")}
            />

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <HelpItem
              icon={<GithubIcon className="size-3" />}
              label="GitHub repo"
              onSelect={() => void openUrl(GITHUB_URL)}
            />
            <HelpItem
              icon={<MessageCircle size={12} />}
              label="Discord community"
              onSelect={() => void openUrl(DISCORD_URL)}
            />
            <HelpItem icon={<XIcon />} label="Follow on X" onSelect={() => void openUrl(X_URL)} />

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <HelpItem
              icon={<Globe size={12} />}
              label="Our website"
              onSelect={() => void openUrl(SITE_URL)}
            />

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <HelpItem
              icon={<ArrowDownToLine size={12} />}
              label="Check for updates"
              onSelect={checkForUpdates}
            />
            {version && (
              <HelpItem
                icon={<Info size={12} />}
                label={`Atlas ${version}`}
                hint="Copy"
                // The bare number is what a version field or a release tag
                // wants; the toast repeats it so there is no doubt about what
                // was copied. `copyText` RESOLVES false on failure rather than
                // rejecting, so the result has to be read.
                onSelect={() =>
                  void copyText(version).then((ok) => {
                    if (ok) toast.success(`Copied ${version}`);
                    else toast.error("Could not copy the version.");
                  })
                }
              />
            )}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** X's mark. Not in lucide (it ships the pre-rebrand bird), and `currentColor`
 *  on a `fill` so it tracks the row's hover step like every other icon here. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The running build's version. Read from Tauri rather than `package.json`:
 *  the bundle carries its own version, and a stale import would claim the
 *  wrong one after an update. Renders nothing until it resolves. */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {
        // Not worth surfacing: the help menu simply leaves the row out.
      });
    return () => {
      live = false;
    };
  }, []);
  return version;
}

/** The manual update check the window bar's update icon used to offer when
 *  idle; that icon now appears only once there is an update to show. */
function checkForUpdates(): void {
  void updater
    .checkNow()
    .then((status) => {
      if (!status.available) {
        toast.success(`You're on the latest version (${status.currentVersion}).`);
      }
    })
    .catch((e) =>
      toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`),
    );
}
