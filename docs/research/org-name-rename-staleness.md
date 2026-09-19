# Organisation rename never reaches the desktop

*Investigation report — 2026-09-16, branch `0.3.2` at `e5228d15`. Source-only: no run, no server access. Every claim below cites the file and line it was read from; where the repo cannot answer, the note says so.*

## 1. The claim and the verdict

> "If someone updates the org name, that name does not update in the app."

**Confirmed from source, and it is permanent, not merely slow.** The org name lives in two caches. The Rust auth layer *does* re-pull it (`GET /organization/list`) on every launch and on the switcher's manual refresh. But every visible surface renders from a second, local store — `useOrgStore` / `state.json` — and the only writer that carries server data into that store, `mergeServerOrgs`, is explicitly **add-only**: an org whose `remoteId` is already known is skipped with `continue` before its name is ever compared. So the fresh name arrives in the renderer on every launch and is thrown away every time.

```ts
// src/features/organisations/stores/org-store.ts:353-354
for (const s of serverOrgs) {
  if (linked.has(s.id)) continue; // add-only: already linked, leave it
```

Relaunching, pressing the refresh icon, signing out and back in — none of them change the label. Only deleting the org locally (so the next merge re-adds it under the current server name) would.

A second, independent gap sits behind it: between launches the Rust cache itself is only refreshed on demand — there is no focus, timer or realtime trigger — so even after the add-only bug is fixed, a rename on the web would land at the *next launch* or *manual refresh*, not live.

## 2. Method

Started from `graphify query "organisation name storage and display"` (159-node subgraph rooted at `org-store.ts`, `org-switcher.tsx`, `auth-api.ts`, `auth-store.ts`, `app_state.rs`, `titlebar.tsx`), then confirmed every edge by reading the files. Greps over `src/` and `src-tauri/src/` for `.name` reads on org objects, for `/organization/*` endpoints, and for any focus / interval / SSE / react-query refresh mechanism. Git history of `src/features/organisations` since 2026-08-01 was reviewed for context; none of the recent commits (`e0eb4199` org-id copy button, `b7d0c038` org switch cache miss, `57e8fa63` comms org switcher patch) touch the merge logic — it has been add-only since it was introduced in `130f9b50` (2026-07-23, "sync organisation create, list, and delete with the server").

No server or gateway code is vendored in this repo (`grep -rl "organization/list"` hits only `src-tauri/src/auth/{core,store,tests}.rs`; `landing/` is a static site), so anything about server-side behaviour — what a web rename does, whether the gateway emits an event — is marked unverifiable.

## 3. Where the org name enters the app

There is exactly one ingress, and it is in Rust.

| Step | What | Where |
|---|---|---|
| 1 | `GET /organization/list` — "the only source of organisation *names*" | `src-tauri/src/auth/core.rs:503-517` |
| 2 | Deserialised as `OrgEntry { id, name }`; slug, logo, timestamps "deliberately not read" | `src-tauri/src/auth/core.rs:1503-1509` |
| 3 | `resolve_orgs` joins the names with roles from the access token's `orgs` claim (`{ organisationId: role }`, "no names at all") | `src-tauri/src/auth/core.rs:456-500`, claim decode `:1583-1606`, `store.rs:80-81` |
| 4 | Written into the credential file as `StoredIdentity.orgs: Vec<StoredOrg { id, name, role }>` | `src-tauri/src/auth/core.rs:534-609` (save at `:596-609`), `src-tauri/src/auth/store.rs:83-93`, `:131` |
| 5 | Surfaced as `AuthSnapshot::SignedIn { orgs: Vec<AccountOrg> }` | `src-tauri/src/auth/core.rs:328-347`; TS mirror `src/features/auth/lib/auth-api.ts:65-74`, `:98` |
| 6 | Broadcast to every window on `atlas:auth-changed` | `src-tauri/src/commands/auth.rs:61-68`; listener `src/features/auth/lib/auth-api.ts:249-250` |
| 7 | Renderer: `useAuthStore.setSnapshot` + `useOrgStore.mergeServerOrgs(snapshot.orgs)` | `src/App.tsx:230-252` |

So the name is **not** in the JWT (the claim carries only roles, `store.rs:80-81`), it **is** persisted to disk in the credential file (`core.rs:596-609`), and it **is** re-fetched by the server round-trip described in §5.

The second cache — the one the UI reads — is the local organisation store, persisted in `state.json`:

* Renderer store: `useOrgStore.organisations: Organisation[]` — `src/features/organisations/stores/org-store.ts:108-112`; shape `src/features/organisations/types.ts:22-30` (`name`, `slug`, `remoteId`, `syncEnabled`…).
* Persisted via `scheduleAppStateSave()` → `invoke("save_app_state")` — `src/features/project/stores/project-store.ts:157-160`, `:151` — into Rust `AppState.organisations` — `src-tauri/src/state/app_state.rs:100-129`, `:146`.
* Hydrated at boot from that file — `org-store.ts:174-185`, `project-store.ts:496`.

The server list only ever enters this store through `mergeServerOrgs` (`org-store.ts:336-401`), which links by `remoteId` (`:343-347`) and, for an unknown server org, either adopts a same-named local row (`:361-381`) or appends a new row copying `s.name` once (`:383-393`).

## 4. Every place the org name is displayed or used

All of these read `useOrgStore` (directly or via `useActiveOrganisation()`, `src/features/chat/stores/ai-grant-store.ts:139-141`) — i.e. the **stale** copy.

| Surface | Read | Where |
|---|---|---|
| Titlebar `org / project` pill | `organisations.find(o => o.id === activeOrganisationId)?.name` | `src/components/titlebar.tsx:83-85`, rendered `:159`, `:341-344` |
| Org switcher trigger (active org label) | `active.name` | `src/features/organisations/components/org-switcher.tsx:245` |
| Org switcher list rows | `org.name` | `org-switcher.tsx:378` |
| Org avatar (initials, no logo) | `initials(org.name)` | `org-switcher.tsx:33-38`, `:79`, `:105` |
| Switcher sync rows / delete confirm | `active.name`, `org?.name` | `org-switcher.tsx:499`, `:507`, `:532`, `:585` |
| Switcher search filter | `o.name`, `o.slug` | `org-switcher.tsx:160-166` |
| AI-grant bar ("X doesn't have AI grants") | `org?.name ?? account?.orgs…name` — snapshot is only the fallback | `src/features/chat/components/ai-grant-bar.tsx:46-50` |
| Members modal title / header | `org.name` | `src/features/organisations/components/members-modal.tsx:180`, `:185` |
| Capture popover local-only notice | `activeOrg?.name` | `src/features/capture/components/capture-popover.tsx:253` |
| Comms "not connected" panel | `org.name` | `src/features/comms/components/comms-not-connected.tsx:47` |
| Jump-to-terminal toast | `org?.name` | `src/features/terminal/lib/jump-to-terminal.ts:39` |
| Activity log summaries | `org.name`, `target.name` | `org-store.ts:207`, `:269`, `:433`; `src/features/organisations/lib/org-switch.ts:197` |
| Telemetry group `$group_set.name` (Rust) | `resolve_org` reads the **local** `AppState` row's `org.name` | `src-tauri/src/commands/telemetry.rs:41-72`, consumed at `src-tauri/src/telemetry/mod.rs:599-605` |
| Telemetry person property `org_name` (Rust) | `sync_identity` reads the **auth snapshot** name | `src-tauri/src/commands/auth.rs:100-127` |

The last two rows mean the two analytics identities disagree after a rename: the group carries the stale local name, the person property carries the fresh server name.

Surfaces that read the *fresh* copy (`snapshot.orgs`) are few and never render the name: the switcher's access gate builds a `Set` of ids (`org-switcher.tsx:124-130`), the members modal reads the caller's role (`members-modal.tsx:107`), and the AI-grant bar uses it as a fallback only (`ai-grant-bar.tsx:50`). The account menu (`src/features/auth/components/account-avatar.tsx`) renders no org fields at all.

## 5. Is there an in-app rename? How and when does the app re-fetch?

**Yes — but it is local-only.** The switcher's pencil (`org-switcher.tsx:381-392`) opens an inline input whose `submitRename` (`:199-216`) calls `useOrgStore.actions.rename`:

```ts
// src/features/organisations/stores/org-store.ts:275-285
rename: (id, name) => {
  …
  set((s) => ({
    organisations: s.organisations.map((o) => (o.id === id ? { ...o, name: trimmed } : o)),
  }));
  scheduleAppStateSave();
  return true;
},
```

No server call. The Rust client has no org-update endpoint: the full set it speaks is `/organization/list` (`core.rs:513`), `/create` (`:933`), `/check-slug` (`:971`), `/delete` (`:997`), `/get-full-organization` (`:1051`), `/list-invitations` (`:1116`), `/invite-member` (`:1177`), `/cancel-invitation` (`:1213`), `/update-member-role` (`:1241`), `/remove-member` (`:1268`). So a desktop rename of a synced org silently diverges from the server, and (today) a server rename silently diverges from the desktop. Whether the server exposes an org-update route at all cannot be verified from this repo.

**When the app re-fetches the server list** — the Rust side, layer A:

| Trigger | Path | Cite |
|---|---|---|
| Launch | `lib.rs` setup → `restore_on_launch` → broadcast stored snapshot, then `core.revalidate` → `validate_once` → `mint_access_token` (`/token`) → `refresh_identity` → `resolve_orgs` → broadcast | `src-tauri/src/lib.rs:262`, `src-tauri/src/commands/auth.rs:497-514`, `src-tauri/src/auth/core.rs:1361-1375`, `:1317-1333`, `:534-552` |
| Manual refresh icon in the switcher | `auth.refresh()` → `auth_refresh` → `core.refresh()` → `refresh_identity` → broadcast | `org-switcher.tsx:302-319`, `src/features/auth/lib/auth-api.ts:168`, `commands/auth.rs:341-351`, `core.rs:1285-1290` |
| Side effects of create / delete / remove-member | those commands re-broadcast a refreshed snapshot | `commands/auth.rs:288-296`, `:353-358`, `:460-462` |
| Window focus | **none** — `onWindowFocusChange` has no subscribers outside its module (`src/lib/window-focus.ts:33-40`; grep of `src/` finds no callers) | — |
| Timer / poll | **none** — the only sleep loops in the auth core are the device-grant poll (`core.rs:716-727`) and the launch backoff (`:1361-1375`) | — |
| Realtime | **none** — the comms socket retargets on org *id* only (`src-tauri/src/commands/comms.rs:174-220`); no org-updated event kind exists in `src-tauri/src/comms` (grep) | — |
| react-query | not used for auth; the global client is `refetchOnWindowFocus: false`, `staleTime` 5 min anyway | `src/main.tsx:18-21` |

The code's own expectation is that layer A is enough: `store.rs:98-100` — "Refreshed on every successful validation, so a name, photo, or role changed on the web reaches the desktop on the next launch." That is true for the *user's* name and photo (`auth-store.ts:83-92` replaces the whole snapshot) and false for org names, because of layer B.

## 6. Root cause, precisely

**Primary — the add-only merge (layer B never takes the name).**
`mergeServerOrgs` (`org-store.ts:336-401`) computes the set of already-linked `remoteId`s (`:343-347`) and skips any server org in it (`:353-354`, quoted in §1). The name is only ever copied on first sight (`:387`), and `changed` stays `false` for an unchanged set, so `set()` and the disk save are never reached (`:398-400`). The design intent is stated in its doc comment — "Add-only merge of the server's org list into the local one: link/add every server org not already linked locally, keeping local-only orgs" (`:155-157`) — and it was written that way when create/list/delete sync first landed (`130f9b50`). Nothing else writes server data into `useOrgStore`; the boot hydrate (`:174-185`) loads whatever `state.json` last saved, which is the name as of first link (or a local rename).

Because every surface in §4 reads layer B, the freshness of layer A is invisible. This is why the bug survives relaunch.

**Secondary — layer A is refreshed only on launch or by hand.** Documented above (§5 table). After the primary fix, the observable behaviour would be "renamed on the web → correct after the next Atlas launch or refresh click", which may or may not meet the bar the reporter has in mind.

**Not the cause** (checked and ruled out): the name is not a JWT claim (`store.rs:80-81`, `core.rs:1565-1583`); there is no react-query cache for orgs (`src/main.tsx` client is unused by auth); the Rust credential file is re-written on every successful validation (`core.rs:596-609`) and `snapshot()` reads it fresh (`core.rs:328-347`).

## 7. Related staleness

| Field | Behaviour | Cite |
|---|---|---|
| **Org slug** | Never taken from the server; computed locally as `uniqueSlug(slugify(s.name))` at first merge and "kept stable thereafter" | `org-store.ts:388`, `app_state.rs:103-106`, `core.rs:1503-1504` |
| **Org logo / avatar** | Server logo is deliberately not read (`OrgEntry` has no field); local `logo?` exists on the type but nothing populates it and no UI reads it; the avatar is `initials(org.name)`, so it inherits the stale name | `core.rs:1503-1509`, `types.ts:28`, `app_state.rs:109-110`, `org-switcher.tsx:33-38` |
| **Member role (own)** | Re-read from the JWT `orgs` claim on every validation; renders from `snapshot.orgs`, so it heals at next launch / refresh. Rust also falls back to the previous role when the claim is unreadable | `core.rs:472-497`, `members-modal.tsx:107`, `auth-api.ts:197` |
| **User display name / photo** | Re-fetched by `refresh_identity` on every validation and mirrored wholesale into `useAuthStore`; heals at next launch / refresh, never live | `core.rs:534-552`, `store.rs:98-100`, `auth-store.ts:83-92` |
| **Plan / tier** | No such field anywhere in the auth client or snapshot (grep of `src-tauri/src/auth` for `plan`, `tier`, `subscription` is empty). The AI-grant entitlement is a separate per-org gateway probe with its own store | `src/features/chat/stores/ai-grant-store.ts:161-179` |

## 8. Mechanisms a fix could reuse

1. **The `atlas:auth-changed` funnel.** Every path that touches the credential — launch, manual refresh, create/delete/remove-member, `auth_set_active_org` — ends in `broadcast()` (`commands/auth.rs:61-68`) and lands in the one App-level listener (`App.tsx:233-241`) that already calls `mergeServerOrgs`. A name-aware merge needs no new plumbing.
2. **`auth.refresh()` / `auth_refresh`.** A one-call "re-pull orgs and re-broadcast", already wired to the switcher icon (`org-switcher.tsx:302-319`, `auth-api.ts:168`, `commands/auth.rs:341-351`). Any new trigger (focus, timer) can invoke it.
3. **Native focus tracking.** `onWindowFocusChange(cb)` and the `atlas:window-active` rising-edge event exist and are idle (`src/lib/window-focus.ts:33-40`, `:55-80`). The chat pipeline already uses `atlas:window-active` as a "cold wake" (`App.tsx:719` comment).
4. **Request budget guard.** The auth core documents a global ceiling of 100 requests / 60 s and that a successful validation costs 3 (`core.rs:505-511`); the members store shows the house pattern for a freshness window + `force` flag (`members-store.ts:92-100`).
5. **A realtime channel exists** — the Rust comms socket follows the active org (`commands/comms.rs:174-220`) — but no org-metadata event is defined on it, and whether the gateway would emit one is unverifiable here.

## 9. Fix options (ranked, none implemented)

1. **Make `mergeServerOrgs` reconcile names for already-linked rows.** Replace the `continue` at `org-store.ts:354` with a compare-and-patch: when `o.remoteId === s.id && o.name !== s.name`, map the row to `{ ...o, name: s.name }` and set `changed = true`, so `:399-400` persist it. One file plus a unit test (none exists today — `mergeServerOrgs` is referenced only from `App.tsx` and its own store). Fixes launch, manual refresh and every rebroadcast at once. Decide what happens to the local `rename` (`:275-285`) for synced orgs: it would now be overwritten on the next broadcast, so either hide the pencil for `syncEnabled && remoteId` rows (`org-switcher.tsx:381-392`) or, if the server has an update route (unverifiable here), add it to `core.rs` / `commands/auth.rs` / `auth-api.ts` and call it from `rename`.
2. **Add a live trigger on top of (1): debounced `auth.refresh()` on the focus rising edge.** Subscribe via `onWindowFocusChange` or `atlas:window-active` in `App.tsx`, gate it to at most once per N minutes to respect `core.rs:505-511`, and only when `snapshot.status === "signed-in"`. Files: `src/App.tsx` (or a small hook next to `auth-store.ts`). Makes a web rename show up the next time the user comes back to Atlas, which is how the web session itself behaves.
3. **Server push.** Define an org-updated event on the comms socket, have the Rust handler call `core.refresh()` + `broadcast()` (`src-tauri/src/commands/comms.rs`, `src-tauri/src/auth/core.rs`). Truly live, but depends on the gateway emitting such an event — not verifiable from this repo — and still requires (1) for the renderer to accept the name.
