// Where the chat sidebar names a thread's project.
//
// Scoped to an open project, nearly every row is that project's, so naming it
// on each card is noise: only a row from another project gets its name, on
// the card, because it resumes somewhere else. With no project open the list
// mixes projects, and each run of rows goes under a heading instead.

export interface GroupableRow {
  projectName: string;
  /** The row belongs to a project other than the open one. */
  elsewhere: boolean;
}

export interface RowPlacement {
  /** A heading to draw above the row, or `null`. */
  heading: string | null;
  /** Whether the card itself names its project. */
  showProject: boolean;
}

/**
 * Place the project name for each row of an already-filtered list. `grouped`
 * is "no project is open" — the sidebar's `threads_projects` marks nothing
 * current. Headings are stamped on the filtered rows, so a search that hides
 * a project's first row does not take its heading along.
 */
export function placeProjectNames(rows: readonly GroupableRow[], grouped: boolean): RowPlacement[] {
  return rows.map((row, index) => ({
    heading: grouped && row.projectName !== rows[index - 1]?.projectName ? row.projectName : null,
    showProject: !grouped && row.elsewhere,
  }));
}

export interface SortableThread {
  threadId: string;
  updatedAt: string;
  createdAt: string | null;
}

/**
 * One project's threads in the `sidebarSort` order. Rust hands them over by
 * latest activity already, so `recent` keeps that order untouched; `created`
 * puts the most recently started first, with a thread whose start Atlas never
 * saw counted from its last activity, as the history view does.
 */
export function sortThreads<T extends SortableThread>(
  threads: readonly T[],
  sort: "recent" | "created",
): readonly T[] {
  if (sort === "recent") return threads;
  const started = (thread: T) => thread.createdAt ?? thread.updatedAt;
  return [...threads].sort(
    (a, b) => started(b).localeCompare(started(a)) || a.threadId.localeCompare(b.threadId),
  );
}

/** How many settled rows the shelf shows when first opened, and how many more
 *  each "Show more" adds. A long-lived project settles hundreds. */
export const SETTLED_SHELF_FIRST_PAGE = 10;
export const SETTLED_SHELF_PAGE = 25;

export interface SettleableRow {
  threadId: string;
  /** RFC 3339; `null` while the session is active. */
  settledAt: string | null;
}

/**
 * Split the sidebar's rows into the active list and the Settled shelf. The
 * active rows keep the order they came in (the `sidebarSort` order); the
 * shelf is most recently settled first, whatever that setting says — it is a
 * record of what was put away, and the newest put away is the likeliest to be
 * wanted back.
 */
export function splitSettled<T extends SettleableRow>(
  rows: readonly T[],
): { active: T[]; settled: T[] } {
  const active: T[] = [];
  const settled: T[] = [];
  for (const row of rows) (row.settledAt ? settled : active).push(row);
  settled.sort(
    (a, b) => b.settledAt!.localeCompare(a.settledAt!) || a.threadId.localeCompare(b.threadId),
  );
  return { active, settled };
}

/**
 * Where to go once the open session is settled: the next active row below
 * it, else the nearest one above, else nowhere (`null`, and the caller starts
 * a fresh session). `rows` is the active list as shown.
 */
export function nextAfterSettling<T extends { threadId: string }>(
  rows: readonly T[],
  threadId: string,
): T | null {
  const index = rows.findIndex((row) => row.threadId === threadId);
  if (index === -1) return rows[0] ?? null;
  return rows[index + 1] ?? rows[index - 1] ?? null;
}
