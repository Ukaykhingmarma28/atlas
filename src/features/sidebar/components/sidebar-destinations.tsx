// The sidebar footer's destinations as icon buttons, one component each, so
// each subscribes to its own slice of the layout store. Each
// toggles what it opens (back to the session when it is already on screen)
// and lights while its view is the one showing. Team chat stays visible when
// it is locked, greyed, saying what unlocks it.
//
// No motion on any of them: they are pressed many times a day, and the view
// they open is the feedback. Hover is a colour step only.

import type { ComponentProps } from "react";
import { BookOpen, GitBranch, MessagesSquare } from "lucide-react";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";
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

/** One destination: an icon that lights while its view is on screen. Must
 *  sit inside a `HintGroup`. */
export function DestinationButton({
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

export function TeamChatButton() {
  const open = useLayoutStore(teamChatShown);
  const access = useTeamAccess();
  return (
    <DestinationButton
      icon={MessagesSquare}
      label="Team chat"
      active={open}
      locked={unlockHint(access, "team chat")}
      onClick={access.locked ? (access.unlock ?? noop) : toggleTeamChat}
    />
  );
}

export function TimelineButton() {
  const open = useLayoutStore((s) => destinationShown(s, "artifacts"));
  return (
    <DestinationButton
      icon={DESTINATIONS.artifacts.icon}
      label="Timeline"
      active={open}
      onClick={() => toggleDestination("artifacts")}
    />
  );
}

export function MemoryButton() {
  const open = useLayoutStore((s) => destinationShown(s, "memory"));
  return (
    <DestinationButton
      icon={DESTINATIONS.memory.icon}
      label="Memory"
      active={open}
      onClick={() => toggleDestination("memory")}
    />
  );
}

export function UsageButton() {
  const open = useLayoutStore((s) => destinationShown(s, "usage"));
  return (
    <DestinationButton
      icon={DESTINATIONS.usage.icon}
      label="Usage"
      active={open}
      onClick={() => toggleDestination("usage")}
    />
  );
}

// Knowledge and source control belong to a project; without one open they
// say so instead of opening a view with nothing in it.

export function KnowledgeButton() {
  const open = useLayoutStore((s) => destinationShown(s, "knowledge"));
  const hasProject = useAppStore((s) => !!s.currentProject);
  return (
    <DestinationButton
      icon={BookOpen}
      label={hasProject ? "Knowledge" : "Open a project to open its knowledge base"}
      active={open}
      disabled={!hasProject}
      onClick={() => toggleDestination("knowledge")}
    />
  );
}

export function SourceControlButton() {
  const open = useLayoutStore(sourceControlShown);
  const hasProject = useAppStore((s) => !!s.currentProject);
  return (
    <DestinationButton
      icon={GitBranch}
      label={hasProject ? "Source control" : "Open a project to see its source control"}
      active={open}
      disabled={!hasProject}
      onClick={toggleSourceControl}
    />
  );
}
