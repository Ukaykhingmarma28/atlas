import type { ElementType } from "react";
import {
  Brain,
  BrainCircuit,
  Code,
  GitBranch,
  Globe,
  Map,
  ScrollText,
  Terminal,
} from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import type { TabType } from "@/lib/constants";
import { useLayoutStore } from "../stores/layout-store";

/**
 * What a split column can open: the `+` menu and the "Open a surface" launcher
 * an empty column shows. One list, so the two
 * can never offer different things.
 *
 * `key` is a bare letter. It is the hint shown beside each row AND the key that
 * picks it — inside the open `+` menu, and anywhere while a focused column is
 * showing the launcher — so `⌘T` then `A` is a new agent, `⌘T` then `T` a
 * terminal. The hint and the match read the same field, so they cannot drift.
 */
export interface Surface {
  type: TabType;
  label: string;
  icon: ElementType;
  key: string;
}

export const SURFACES: readonly Surface[] = [
  { type: "chat", label: "Agent", icon: AtlasIcon, key: "A" },
  { type: "terminal", label: "Terminal", icon: Terminal, key: "T" },
  { type: "browser", label: "Browser", icon: Globe, key: "B" },
  { type: "editor", label: "New file", icon: Code, key: "N" },
  { type: "canvas", label: "Spaces", icon: Map, key: "S" },
  { type: "knowledge", label: "Knowledge", icon: Brain, key: "K" },
  { type: "memory", label: "Memory", icon: BrainCircuit, key: "M" },
  { type: "source-control", label: "Source control", icon: GitBranch, key: "G" },
  { type: "log", label: "Log", icon: ScrollText, key: "L" },
];

/** Open `surface` as a new tab in split column `groupId`. */
export function openSurface(surface: Surface, groupId: string): void {
  const { addTab, setActiveTab } = useLayoutStore.getState().actions;
  if (surface.type === "source-control") {
    // One per window, wherever it is: a second copy would be the same repo.
    const existing = useLayoutStore.getState().tabs.find((t) => t.type === "source-control");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
  }
  const ts = Date.now();
  if (surface.type === "editor") {
    // The synthetic `untitled:<ts>` path starts the editor on an empty buffer
    // that falls into save-as on ⌘S (see `editor-panel.tsx`).
    addTab(
      {
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      },
      groupId,
    );
    return;
  }
  addTab(
    {
      id: surface.type === "source-control" ? "source-control" : `${surface.type}-${ts}`,
      type: surface.type,
      title: surface.type === "chat" ? "Agents" : surface.label,
      closable: true,
      dirty: false,
      data: {},
    },
    groupId,
  );
}

/**
 * The surface a key press picks: a bare letter, no modifiers, not mid-IME
 * composition. Shared by the `+` menu and the launcher.
 */
export function surfaceForKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): Surface | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  return SURFACES.find((s) => s.key.toLowerCase() === key) ?? null;
}

/** Event that opens split column `groupId`'s `+` menu — what `⌘T` sends once
 *  the window is already split. */
export const OPEN_SURFACE_MENU_EVENT = "atlas:open-surface-menu";
