export const TAB_TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "commit",
  "session-changes",
  "source-control",
  "log",
  "media",
  "svg",
  "pdf",
  "notebook",
  "unsupported",
  "usage",
  "artifacts",
  "comms-draft",
  "spaces",
  "team-chat",
] as const;

export type TabType = (typeof TAB_TYPES)[number];

/**
 * Tab types that work with NO project open — org-scoped surfaces, not
 * project ones. The projectless centre shell renders only these; the rest
 * of a project's tabs stay in the store untouched and reappear when a
 * project opens.
 */
export const PROJECTLESS_TYPES: ReadonlySet<TabType> = new Set<TabType>([
  "comms-draft",
  "spaces",
  "usage",
  "team-chat",
]);

/**
 * Tab types that belong to the WINDOW, not to a project: one per window, and
 * they follow the user from project to project instead of staying behind in
 * the project they were opened in.
 *
 * Team chat is the one: it is the same conversation whichever project is
 * open. It is not org-scoped — nothing in the tab names an org, and the panel
 * retargets with the socket — so an org switch leaves it open. It is never
 * written to the per-project editor state; whether it was open is a layout
 * preference (`teamChat.open`), restored on boot.
 */
export const WINDOW_TYPES: ReadonlySet<TabType> = new Set<TabType>(["team-chat"]);

/**
 * Tab types whose CONTENT belongs to one Organisation — their ids and data
 * embed conversation/draft ids that exist in exactly one org.
 *
 * Two consequences, both load-bearing:
 *  - they are closed on every org change (`switchOrg`, and the boot
 *    reconciliation branch in the comms store);
 *  - they are NEVER written to the per-project editor state. That file is
 *    keyed by PROJECT PATH, and the same path is commonly open in several
 *    orgs — a persisted Space tab came back on the incoming org's mount
 *    pointing at the outgoing org's conversation ("This Space is no longer
 *    available"), which is what closing alone could not fix.
 *
 * Settings is deliberately absent: it is projectless but org-agnostic.
 */
export const ORG_SCOPED_TYPES: ReadonlySet<TabType> = new Set<TabType>([
  "comms-draft",
  "spaces",
  "usage",
]);

/**
 * Where a tab type opens (ADR-0024):
 *
 *  - `session`: the session column, which shows no tab strip.
 *  - `surface`: a tab in the surfaces pane beside the session. `minWidth` is
 *    the narrowest its layout still works at, in CSS pixels; a column showing
 *    it will not resize below that.
 *  - `destination`: a full-page view that takes the area right of the rail,
 *    one at a time, while the session runs underneath.
 *
 * The test: do you use it WHILE working in a session, and does it have a
 * useful form at column width (about 320–600px)? Yes to both is a surface; no
 * to either is a destination. A destination that someone needs beside the
 * session gets a peek, a compact view designed for a column, never its full
 * page squeezed into one.
 *
 * A `Record`, so adding a tab type without a placement does not compile.
 */
export type Placement =
  | { kind: "session" }
  | { kind: "surface"; minWidth: number }
  | { kind: "destination" };

export const TAB_PLACEMENT = {
  chat: { kind: "session" },

  editor: { kind: "surface", minWidth: 320 },
  terminal: { kind: "surface", minWidth: 280 },
  browser: { kind: "surface", minWidth: 360 },
  diff: { kind: "surface", minWidth: 360 },
  commit: { kind: "surface", minWidth: 360 },
  "session-changes": { kind: "surface", minWidth: 320 },
  "source-control": { kind: "surface", minWidth: 300 },
  "team-chat": { kind: "surface", minWidth: 320 },
  "comms-draft": { kind: "surface", minWidth: 320 },
  log: { kind: "surface", minWidth: 300 },
  pdf: { kind: "surface", minWidth: 320 },
  notebook: { kind: "surface", minWidth: 360 },
  media: { kind: "surface", minWidth: 240 },
  svg: { kind: "surface", minWidth: 240 },
  unsupported: { kind: "surface", minWidth: 240 },
  // Retired; a saved one still renders its placeholder.
  tasks: { kind: "surface", minWidth: 240 },

  artifacts: { kind: "destination" },
  usage: { kind: "destination" },
  knowledge: { kind: "destination" },
  "knowledge-graph": { kind: "destination" },
  memory: { kind: "destination" },
  canvas: { kind: "destination" },
  spaces: { kind: "destination" },
} as const satisfies Record<TabType, Placement>;

/** The tab types that are destinations, as a type, so a map keyed by it (the
 *  destination screen's panels, their titles) must cover every one. */
export type DestinationType = {
  [K in TabType]: (typeof TAB_PLACEMENT)[K]["kind"] extends "destination" ? K : never;
}[TabType];

export function isDestination(type: TabType): type is DestinationType {
  const p: Placement = TAB_PLACEMENT[type];
  return p.kind === "destination";
}

/** The narrowest a column showing `type` may be, in CSS pixels; `null` for a
 *  type that never sits in a surfaces column. */
export function surfaceMinWidth(type: TabType): number | null {
  const p: Placement = TAB_PLACEMENT[type];
  return p.kind === "surface" ? p.minWidth : null;
}

/**
 * Tab types that were renamed. Persisted layout / editor state written by an
 * older build still carries the old name; `migrateTabType` maps it forward so
 * the tab comes back instead of being dropped as unknown.
 */
export const LEGACY_TAB_TYPES: Record<string, TabType> = { "mission-control": "usage" };

/** The current name for a stored tab type: the mapped type for a legacy name,
 *  the type itself when it is still valid, `null` when it is neither. */
export function migrateTabType(type: string): TabType | null {
  const legacy = LEGACY_TAB_TYPES[type];
  if (legacy) return legacy;
  return (TAB_TYPES as readonly string[]).includes(type) ? (type as TabType) : null;
}
