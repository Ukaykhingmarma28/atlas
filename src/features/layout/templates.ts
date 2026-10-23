import type { TabType } from "@/lib/constants";

type LeftSection = "files" | "knowledge";

/** A predefined panel/split/tab arrangement applied via the layout switcher
 *  (⌘⌥L) or Settings → Layouts. Applied to the ACTIVE project. */
export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  /** Left panel visibility (omitted = hidden). */
  panels: { left?: boolean };
  leftSection?: LeftSection;
  /** Split columns, left→right (1–3). Each cell is the tab type that fills it;
   *  the first is the main column, which holds the agent. */
  columns: { type: TabType; title: string }[];
  /** Index of the column to focus after applying (default last). */
  focus?: number;
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: "focus",
    name: "Focus",
    description: "Just the agent — single column, no side panels.",
    panels: {},
    columns: [{ type: "chat", title: "Agents" }],
  },
  {
    id: "develop",
    name: "Develop",
    description: "Files + editor + agent. The classic IDE setup.",
    panels: { left: true },
    leftSection: "files",
    columns: [
      { type: "chat", title: "Agents" },
      { type: "editor", title: "Editor" },
    ],
    focus: 0,
  },
  {
    id: "research",
    name: "Research",
    description: "Knowledge, agent and the web side by side.",
    panels: {},
    columns: [
      { type: "chat", title: "Agents" },
      { type: "knowledge", title: "Knowledge" },
      { type: "browser", title: "Browser" },
    ],
    focus: 0,
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Agent next to a terminal, with the file tree.",
    panels: { left: true },
    leftSection: "files",
    columns: [
      { type: "chat", title: "Agents" },
      { type: "terminal", title: "Terminal" },
    ],
    focus: 0,
  },
  {
    id: "review",
    name: "Review",
    description: "Agent with source control beside it.",
    panels: {},
    columns: [
      { type: "chat", title: "Agents" },
      { type: "source-control", title: "Source control" },
    ],
    focus: 0,
  },
  {
    id: "usage",
    name: "Usage",
    description: "Organization token usage and cost, beside the agent.",
    panels: {},
    columns: [
      { type: "chat", title: "Agents" },
      { type: "usage", title: "Usage" },
    ],
    focus: 1,
  },
];
