/**
 * Organisation data model. Local-only in phase 01, but shaped as a superset of
 * the Atlas server contracts (`packages/db` `organization`/`member`/`invitation`
 * + Better Auth) so cloud sync (a separate auth branch) is a thin adapter.
 *
 * Mirrors `src-tauri/src/state/app_state.rs:Organisation`.
 */

/** Org member roles, highest privilege first. Matches the server `Role` enum
 *  (`@atlas/contracts`). Unused in phase 01 (no members locally) — present so
 *  the member-management UI + the auth branch share one type. */
export type Role = "admin" | "product_owner" | "developer" | "member";

/**
 * A top-level tenant that owns a set of projects. Exactly one org is active
 * per window. Local-only until the user opts into sync per org.
 *
 * Server-mapped fields: `id` (sync key), `name`, `slug` (unique + required),
 * `logo`. Local-only fields: `activeProjectId`, `syncEnabled`, `color`, and
 * `remoteId` (the server `organization.id` once linked).
 */
export interface Organisation {
  id: string;
  name: string;
  /** URL-safe unique handle; derived from `name` at create time. */
  slug: string;
  color?: string;
  logo?: string;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
  /** Per-org memory of the last active project (restore target on switch).
   *  Local-only — the server has no active-project concept.
   *
   *  Crosses the wire as `activeWorkspaceId`: see {@link OrganisationWire}. */
  activeProjectId?: string;
  /** Opt-in cloud sync (Chrome-profile model). `false` = local-only. */
  syncEnabled: boolean;
  /** Server `organization.id` once linked via "Turn on sync". Reconciliation
   *  seam for the auth branch. */
  remoteId?: string;
}

/**
 * {@link Organisation} as it appears in `state.json` and in the
 * `save_app_state` / `bootstrap_app_state` payloads. Mirrors
 * `src-tauri/src/state/app_state.rs:Organisation` field for field.
 *
 * The ONE difference from {@link Organisation} is `activeWorkspaceId`. That is
 * a **storage key, not a concept** — the same freeze that keeps the top-level
 * `workspaces` / `activeWorkspaceId` keys (see `AppStateWire`), applied one
 * level down. `AppStatePatch` carries no `deny_unknown_fields` and the field is
 * `#[serde(default)]`, so sending `activeProjectId` here does not fail: Rust
 * drops it, writes `null`, and the install silently loses every org's
 * last-active project. Hence the explicit translation below rather than
 * passing the store's objects through.
 *
 * `tests/state-payload-contract.test.ts` compares this type's keys against the
 * Rust struct's serde names, so a future rename cannot re-open the hole.
 */
export interface OrganisationWire {
  id: string;
  name: string;
  slug: string;
  color?: string;
  logo?: string;
  createdAt?: string;
  /** FROZEN storage key for {@link Organisation.activeProjectId}. */
  activeWorkspaceId?: string;
  syncEnabled: boolean;
  remoteId?: string;
}

/** Store shape → wire shape. The only field that moves is the frozen key. */
export function toOrganisationWire(o: Organisation): OrganisationWire {
  const { activeProjectId, ...rest } = o;
  return activeProjectId === undefined ? rest : { ...rest, activeWorkspaceId: activeProjectId };
}

/** Wire shape → store shape. Inverse of {@link toOrganisationWire}. */
export function fromOrganisationWire(o: OrganisationWire): Organisation {
  const { activeWorkspaceId, ...rest } = o;
  return activeWorkspaceId === undefined ? rest : { ...rest, activeProjectId: activeWorkspaceId };
}

/**
 * Org member. Mirrors the server `member` row + `get-full-organization`
 * response. Unused in phase 01 — shaped for the auth branch to populate.
 */
export interface Member {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt?: string;
  user?: { id: string; name: string; email: string; image?: string };
}

/**
 * Pending/past org invitation. Mirrors the server `invitation` row. Unused in
 * phase 01 — shaped for the auth branch.
 */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role?: Role;
  status?: string;
  expiresAt?: string;
  createdAt?: string;
  inviterId?: string;
}

/**
 * Derive a URL-safe, server-compatible slug from an org name. The server
 * enforces a globally-unique slug; we generate one locally and (in phase 01)
 * disambiguate against the current local org set — the auth branch reconciles
 * against the server on link.
 */
/** A synced org: linked to a server row AND opted into sync. The server owns
 *  its name and membership; a local-only org (either flag off) is the user's. */
export function isSyncedOrg<T extends Pick<Organisation, "syncEnabled" | "remoteId">>(
  org: T,
): org is T & { syncEnabled: true; remoteId: string } {
  return !!(org.syncEnabled && org.remoteId);
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "org";
}
