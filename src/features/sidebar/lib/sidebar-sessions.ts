// The sidebar's session list, as data: which sessions it shows, in which
// section, in what order, and what a search finds.
//
// One flat list across the organisation's projects. Pinned sessions first, in
// their fractional-key order (`pin-order.ts`); then active ones by recency;
// snoozed sessions are hidden until Rust wakes them; settled ones go to the
// Settled shelf, most recently settled first. Every lifecycle rule is Rust's
// (`atlas-thread-metadata`) — `unread` and `woke` arrive already decided, and
// nothing here re-derives them. This module only sorts and filters.

import type { ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";
import { sortByPinOrder } from "@/features/chat/lib/pin-order";
import { sidebarAgentOf, type SidebarAgent } from "@/features/chat/lib/sidebar-agents";

/** A project the sidebar can scope to: one of the active organisation's. */
export interface SidebarProject {
  /** The Atlas project id — what the scope filter remembers. */
  id: string;
  name: string;
  path: string;
}

export type SidebarSection = "pinned" | "active" | "settled";

/** One session, as a sidebar row reads it. Every field is a primitive, so a
 *  memoised row compares cheaply. */
export interface SidebarSession {
  threadId: string;
  /** The agent's session id; what a live tab is matched by. */
  sessionId: string;
  title: string;
  agent: SidebarAgent;
  /** The registry id the row was recorded with. */
  agentId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  /** The session's own working directory — where it resumes. */
  cwd: string;
  branch: string | null;
  updatedAt: string;
  createdAt: string | null;
  settledAt: string | null;
  pinnedAt: string | null;
  pinOrder: string | null;
  unread: boolean;
  woke: boolean;
  liveElsewhere: boolean;
}

export interface SidebarPartition {
  pinned: SidebarSession[];
  active: SidebarSession[];
  settled: SidebarSession[];
  /** Snoozed sessions are not shown; the count is for the empty state. */
  snoozedCount: number;
}

/** A path without its trailing separators, so `/a/b/` and `/a/b` agree. */
export function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** The organisation project a history group belongs to: the one whose folder
 *  holds one of the group's paths. The longest match wins, so a project nested
 *  in another claims its own sessions. */
export function matchProject(
  paths: readonly string[],
  projects: readonly SidebarProject[],
): SidebarProject | null {
  let best: SidebarProject | null = null;
  let bestLength = -1;
  for (const raw of paths) {
    const path = normalizePath(raw);
    for (const project of projects) {
      const root = normalizePath(project.path);
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      if (root.length > bestLength) {
        best = project;
        bestLength = root.length;
      }
    }
  }
  return best;
}

function toSession(thread: ThreadRow, project: SidebarProject): SidebarSession {
  return {
    threadId: thread.threadId,
    sessionId: thread.sessionId ?? "",
    title: thread.title,
    agent: sidebarAgentOf(thread.agentId),
    agentId: thread.agentId,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    cwd: thread.folderPaths[0] ?? project.path,
    branch: thread.branch ?? null,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    settledAt: thread.settledAt,
    pinnedAt: thread.pinnedAt,
    pinOrder: thread.pinOrder,
    unread: thread.unread,
    woke: thread.woke,
    liveElsewhere: thread.liveElsewhere,
  };
}

/** The `sidebarSort` setting: last activity, or when the session started. */
export type SidebarSort = "recent" | "created";

const byRecency = (a: SidebarSession, b: SidebarSession) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.threadId.localeCompare(b.threadId);

const started = (session: SidebarSession) => session.createdAt ?? session.updatedAt;
const byCreated = (a: SidebarSession, b: SidebarSession) =>
  started(b).localeCompare(started(a)) || a.threadId.localeCompare(b.threadId);

/**
 * Sort the history into the sidebar's sections.
 *
 * `scopeProjectId` narrows the list to one project (the header's filter);
 * `null` is every project. `sort` orders the active list (the `sidebarSort`
 * setting); pinned keep their own order and the shelf its settle order. A group outside the organisation's projects is
 * left out — its sessions belong to another organisation, or to a folder this
 * one never opened. A thread with no session id is a draft and has nothing to
 * open yet. `now` decides which snoozes are still running, in case a wake has
 * not reached the row yet.
 */
export function partitionSidebarSessions(input: {
  groups: readonly ThreadProject[];
  projects: readonly SidebarProject[];
  scopeProjectId: string | null;
  now: number;
  sort?: SidebarSort;
}): SidebarPartition {
  const { groups, projects, scopeProjectId, now, sort = "recent" } = input;
  const pinned: SidebarSession[] = [];
  const active: SidebarSession[] = [];
  const settled: SidebarSession[] = [];
  let snoozedCount = 0;
  for (const group of groups) {
    const project = matchProject(group.paths, projects);
    if (!project) continue;
    if (scopeProjectId !== null && project.id !== scopeProjectId) continue;
    for (const thread of group.threads) {
      if (!thread.sessionId) continue;
      const snoozed = thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now;
      if (snoozed) {
        snoozedCount += 1;
        continue;
      }
      const session = toSession(thread, project);
      if (thread.settledAt !== null) settled.push(session);
      else if (thread.pinnedAt !== null) pinned.push(session);
      else active.push(session);
    }
  }
  active.sort(sort === "created" ? byCreated : byRecency);
  settled.sort(
    (a, b) => b.settledAt!.localeCompare(a.settledAt!) || a.threadId.localeCompare(b.threadId),
  );
  return { pinned: sortByPinOrder(pinned), active, settled, snoozedCount };
}

/** The soonest snooze still running, so the list can re-partition when it
 *  ends even if Rust's wake event is late. `null` when nothing is snoozed. */
export function nextSnoozeWake(groups: readonly ThreadProject[], now: number): number | null {
  let soonest: number | null = null;
  for (const group of groups) {
    for (const thread of group.threads) {
      if (!thread.snoozedUntil) continue;
      const at = Date.parse(thread.snoozedUntil);
      if (at > now && (soonest === null || at < soonest)) soonest = at;
    }
  }
  return soonest;
}

/** Sessions whose title, project or branch holds every word of `query`,
 *  case-insensitively. Title matches first, the rest after; each keeps the
 *  order it came in. Empty for an empty query. */
export function searchSidebarSessions(
  sessions: readonly SidebarSession[],
  query: string,
): SidebarSession[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const titleMatches: SidebarSession[] = [];
  const otherMatches: SidebarSession[] = [];
  for (const session of sessions) {
    const title = session.title.toLowerCase();
    if (words.every((word) => title.includes(word))) {
      titleMatches.push(session);
      continue;
    }
    const haystack = `${title} ${session.projectName} ${session.branch ?? ""}`.toLowerCase();
    if (words.every((word) => haystack.includes(word))) otherMatches.push(session);
  }
  return [...titleMatches, ...otherMatches];
}

/** The remembered scope, if its project is still one of the organisation's;
 *  otherwise every project. */
export function resolveScopeProjectId(
  key: string | null,
  projects: readonly SidebarProject[],
): string | null {
  if (key === null) return null;
  return projects.some((project) => project.id === key) ? key : null;
}

/** Where to go once the open session is settled or snoozed: the next row
 *  below it, else the nearest above, else nowhere. */
export function nextAfterParking<T extends { threadId: string }>(
  rows: readonly T[],
  threadId: string,
): T | null {
  const index = rows.findIndex((row) => row.threadId === threadId);
  if (index === -1) return rows[0] ?? null;
  return rows[index + 1] ?? rows[index - 1] ?? null;
}

/** How many settled sessions the shelf shows when opened, and how many more
 *  each "Show more" adds. */
export const SETTLED_SHELF_FIRST_PAGE = 10;
export const SETTLED_SHELF_PAGE = 25;
