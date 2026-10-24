// The title-bar button for a session's terminal drawer.
//
// Self-contained: give it the chat tab, put it in the session's header slot.
// It subscribes to two strings (the tab's session id, and that session's
// drawer flag), so a toggle re-renders this button and the drawer, never the
// chat panel. Hover changes its colour and nothing else; on, it shows the
// pressed fill (`aria-pressed`).

import { SquareTerminal } from "lucide-react";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { overviewScope } from "@/features/chat/stores/session-overview-store";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { toggleSessionDrawer } from "../lib/session-drawer";
import { useSessionDrawerStore } from "../stores/session-drawer-store";

export function TerminalDrawerToggle({ tabId }: { tabId: string }) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const scope = overviewScope(tabId, acpSessionId);
  const open = useSessionDrawerStore((s) => !!s.open[scope]);
  const shortcut = useActionShortcut("chat.toggleTerminalDrawer")?.label;
  const base = open ? "Hide terminal" : "Show terminal";
  const label = shortcut ? `${base} (${shortcut})` : base;
  return (
    <HintItem label={label}>
      <IconButton
        icon={SquareTerminal}
        label={base}
        size="sm"
        iconSize="md"
        aria-pressed={open}
        data-session-terminal-toggle
        onClick={() => toggleSessionDrawer(tabId)}
      />
    </HintItem>
  );
}
