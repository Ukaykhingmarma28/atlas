/**
 * Which recent projects belong to the organisation the user is currently in.
 *
 * Organisations are the tenant boundary, and every other render surface filters
 * by the active one. Recents did not: switching into another org still listed
 * the previous org's project names and absolute paths, and opening one from
 * there silently forked that project into the current org (a duplicate row,
 * tagged to the wrong tenant). This is the filter that closes that.
 *
 * Entries written before recents carried an org have `orgId == null`. Those are
 * attributed by PATH against the project list, which is already org-tagged, so
 * a user's existing recents keep working without a migration. An entry that
 * matches no project at all cannot be attributed to anyone — it is shown, since
 * hiding a path the user opened themselves and that belongs to no org is worse
 * than the alternative, and it leaks nothing about another tenant.
 */

export interface RecentLike {
  path: string;
  orgId?: string | null;
}

export interface ProjectLike {
  path: string;
  orgId?: string | null;
}

/** Path → the orgs that hold a project at that path. */
function ownersByPath(projects: readonly ProjectLike[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const p of projects) {
    if (!p.orgId) continue;
    const set = owners.get(p.path) ?? new Set<string>();
    set.add(p.orgId);
    owners.set(p.path, set);
  }
  return owners;
}

export function recentsForOrg<T extends RecentLike>(
  recents: readonly T[],
  projects: readonly ProjectLike[],
  activeOrgId: string | null | undefined,
): T[] {
  // No active org means the org layer has not hydrated yet. Showing nothing is
  // the safe read: a brief empty list beats a flash of another org's paths.
  if (!activeOrgId) return [];

  const owners = ownersByPath(projects);
  return recents.filter((r) => {
    if (r.orgId) return r.orgId === activeOrgId;
    const known = owners.get(r.path);
    // Untagged and unattributable — belongs to no org, so it hides nothing.
    if (!known || known.size === 0) return true;
    return known.has(activeOrgId);
  });
}
