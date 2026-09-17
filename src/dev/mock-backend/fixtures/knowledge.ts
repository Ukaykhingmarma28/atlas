// Seed content for the `knowledge` scenario: the notes, page metadata and
// cloned repos of the fake `acme-app` project.
//
// Notes are keyed by entry id — the path under `.atlas/knowledge/` without
// `.md`, so `architecture/overview` is a note inside the `architecture` folder.
// Links use the syntax the Rust backlinks engine parses
// (`commands/knowledge_links.rs`): `[[entry-id]]`, `@note:<id>`, and the HTML
// mention chip the editor round-trips (`data-mention-kind` BEFORE `data-id`,
// which is the order the Rust scanner looks for).

import type { ClonedRepo } from "@/features/github/types";
import type { RustPageMeta } from "@/features/knowledge/stores/knowledge-meta-store";
import { MOCK_WORKSPACE } from "../workspace";

const F = "```";

/** An inline mention chip, as the Tiptap editor renders and re-parses it. */
const chip = (id: string, label: string) =>
  `<span data-type="mention" class="atlas-mention-chip" data-mention-kind="note" data-id="${id}">@${label}</span>`;

/** Minutes before the fixed "now" of the scenario, as Rust's RFC 3339. */
export const ago = (minutes: number) =>
  new Date(Date.UTC(2026, 8, 17, 10, 0) - minutes * 60_000)
    .toISOString()
    .replace(".000Z", "+00:00");

export interface SeedNote {
  id: string;
  content: string;
  /** Minutes ago the file was last written; the newest note opens first. */
  age: number;
}

const onboardingSections = [
  ["Accounts you need", "GitHub (acme org), Linear, 1Password, Sentry, and the staging VPN."],
  ["Your first day", "Pair with your onboarding buddy and ship a one-line change end to end."],
  [
    "Repository layout",
    "`apps/web` is the Next.js front end, `apps/api` the Hono API, `packages/*` shared code.",
  ],
  ["Branching", "Feature branches off `main`, squash-merged. Keep PRs under 400 lines."],
  ["Code review", "Two approvals for anything touching auth or billing, one otherwise."],
  ["Testing", "Vitest for units, Playwright for flows. `bun run test` must pass before review."],
  ["Environments", "`dev` (local), `staging` (every merge), `prod` (tagged releases)."],
  ["Feature flags", "Flags live in `packages/flags`. Default everything new to off in prod."],
  [
    "Observability",
    "Traces in Honeycomb, errors in Sentry, logs in Axiom. Link all three in incidents.",
  ],
  ["On-call", "Weekly rotation starting in your second month. Shadow one week first."],
  ["Incidents", "Declare early. The incident channel is `#inc-<date>-<slug>`."],
  ["Releases", "Tuesday and Thursday release trains, cut at 14:00 UTC."],
  ["Design system", "Components come from `packages/ui`. Don't restyle them locally."],
  ["Accessibility", "Every interactive element is keyboard-reachable and labelled."],
  ["Security", "Never paste customer data into tickets. Use the redaction helper in logs."],
  ["Getting help", "Ask in `#eng-help`; nobody minds. Search the knowledge base first."],
];

const onboarding = [
  "# Onboarding handbook",
  "",
  "Everything a new engineer on acme-app needs in their first month. Start with [[welcome]] and set up your machine with [[guides/setting-up-local-dev]].",
  "",
  ...onboardingSections.flatMap(([heading, body], i) => [
    `## ${i + 1}. ${heading}`,
    "",
    body,
    "",
    i % 4 === 0
      ? "- Read the relevant section of [[architecture/overview]] before touching this area."
      : "- Check the architecture overview before touching this area.",
    "- Ask your buddy if anything here is out of date, then fix this page.",
    "",
    `Lorem ipsum stands in for the long-form detail a real handbook would carry here: the history of why step ${i + 1} exists, the two or three mistakes people usually make, and who to ask when it goes wrong. It is deliberately long so the page scrolls well past one screen and the outline has plenty of headings to track.`,
    "",
  ]),
].join("\n");

export const SEED_NOTES: SeedNote[] = [
  {
    id: "welcome",
    age: 4,
    content: `# Welcome to acme-app

This is the team knowledge base. Notes live in \`.atlas/knowledge/\` and travel with the repo.

## Start here

- [[guides/onboarding]] — the first-month handbook
- [[architecture/overview]] — how the pieces fit together
- [[guides/debugging-guide]] — when something is on fire
- [[roadmap-q4]] — what we're building next

## Conventions

1. One topic per page. Link generously with double-bracket wikilinks.
2. Decisions go in \`decisions/\` as numbered ADRs.
3. Mark stale pages **Archived** instead of deleting them.

> The best documentation is the page you update while the context is still in your head.
`,
  },
  {
    id: "roadmap-q4",
    age: 180,
    content: `# Q4 roadmap

| Theme | Owner | Target | Status |
| --- | --- | --- | --- |
| Passkey sign-in | Priya | Oct 15 | In progress |
| Edge caching for the catalog | Marco | Nov 1 | Planned |
| Usage-based billing | Dana | Dec 1 | Discovery |
| Postgres 17 upgrade | Sam | Nov 20 | Planned |

## This sprint

- [x] Ship the passkey enrollment screen
- [x] Load-test the session service
- [ ] Write the rollout plan for passkeys (see [[architecture/auth-flow]])
- [ ] Spike the cache invalidation story from [[decisions/adr-002-edge-caching]]
- [ ] Book the Postgres upgrade window

## Risks

- The billing provider's sandbox is flaky; budget extra time.
- Edge caching depends on the catalog API being idempotent. It mostly is.
`,
  },
  {
    id: "architecture/overview",
    age: 45,
    content: `# Architecture overview

acme-app is a Next.js front end talking to a Hono API, backed by Postgres and a Redis cache.

${F}text
browser ──► web (Next.js, Vercel) ──► api (Hono, Fly.io) ──► Postgres 16
                                            │
                                            └──► Redis (sessions, rate limits)
${F}

## Services

- **web** renders pages and holds no state of its own.
- **api** owns every write. See [[architecture/auth-flow]] for how requests are authenticated.
- **worker** drains the job queue (emails, exports, webhooks).

## Data

The schema is described in [[architecture/data-model]]. We chose Postgres over DynamoDB in [[decisions/adr-001-use-postgres]].

## Caching

Catalog reads are cached at the edge — see [[decisions/adr-002-edge-caching]]. Everything user-specific bypasses the cache.
`,
  },
  {
    id: "architecture/auth-flow",
    age: 95,
    content: `# Auth flow

Sessions are opaque tokens stored in Redis, keyed by a hash of the cookie value. The user and org rows come from ${chip("architecture/data-model", "Data model")}.

## Sign-in

1. The browser posts credentials (or a passkey assertion) to \`/auth/session\`.
2. The API verifies them and writes a session row with a 30-day sliding expiry.
3. The response sets an \`HttpOnly\`, \`SameSite=Lax\` cookie.

${F}ts
export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  await redis.set(\`session:\${sha256(token)}\`, userId, { ex: 60 * 60 * 24 * 30 });
  return token;
}
${F}

## Passkeys

> Passkeys replace passwords for new accounts from October. Existing accounts get an upgrade prompt after sign-in.

- [x] WebAuthn registration endpoint
- [ ] Recovery codes UI
- [ ] Rollout plan — tracked on @note:roadmap-q4

If sign-in loops, start with [[guides/debugging-guide]].
`,
  },
  {
    id: "architecture/data-model",
    age: 300,
    content: `# Data model

Core tables. Every table has \`id uuid\`, \`created_at\` and \`updated_at\`.

| Table | Purpose | Notable columns |
| --- | --- | --- |
| \`orgs\` | A paying customer | \`plan\`, \`billing_email\` |
| \`users\` | A person | \`email\`, \`org_id\` |
| \`projects\` | A workspace inside an org | \`org_id\`, \`archived_at\` |
| \`api_keys\` | Machine access | \`hashed_key\`, \`last_used_at\` |

${F}sql
create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email citext not null unique,
  created_at timestamptz not null default now()
);
${F}

Why Postgres: [[decisions/adr-001-use-postgres]]. Sessions are not here — see [[architecture/auth-flow]].
`,
  },
  {
    id: "guides/debugging-guide",
    age: 20,
    content: `# Debugging guide

Where to look, in order, when something is wrong in production.

<aside class="atlas-callout" data-emoji="🚨">

If customers are affected, declare an incident **before** you start debugging. See the incident section of [[guides/onboarding]].

</aside>

## 1. Is it deployed?

${F}bash
fly releases --app acme-api | head -5
vercel ls acme-web --limit 5
${F}

## 2. What do the traces say?

Filter Honeycomb by \`service.name = api\` and \`status_code >= 500\`, grouped by \`http.route\`.

## 3. Common failures

<details>
<summary>Sign-in redirects in a loop</summary>

The session cookie is being dropped. Check the \`SameSite\` attribute and the domain — details in [[architecture/auth-flow]].

</details>

<details>
<summary>Catalog shows stale prices</summary>

The edge cache wasn't purged. Run the purge job, then read [[decisions/adr-002-edge-caching]].

</details>

## 4. Reproduce locally

Follow [[guides/setting-up-local-dev]], then replay the request:

${F}bash
curl -sS localhost:8787/api/projects -H "authorization: Bearer $ACME_TOKEN" | jq '.[0]'
${F}

Old notes from the Sept 12 outage are in [[meeting-notes/2026-09-12-outage]].
`,
  },
  {
    id: "guides/onboarding",
    age: 600,
    content: onboarding,
  },
  {
    id: "guides/setting-up-local-dev",
    age: 1440,
    content: `# Local setup

${F}bash
brew install bun postgresql@16 redis
git clone git@github.com:acme/acme-app.git && cd acme-app
bun install
docker compose up -d
bun run db:migrate && bun run db:seed
bun run dev
${F}

- [x] Works on Apple Silicon
- [ ] Works on Linux without Docker Desktop

The seeded data matches the tables in [[architecture/data-model]].
`,
  },
  {
    id: "decisions/adr-001-use-postgres",
    age: 4320,
    content: `# ADR 001: Use Postgres as the primary store

**Status:** Accepted · **Date:** 2025-03-02

## Context

We need relational integrity for orgs, users and billing, and the team knows SQL.

## Decision

Use managed Postgres. Model tenancy with an \`org_id\` column on every table (see [[architecture/data-model]]).

## Consequences

- Row-level security is available if we need it.
- Read scaling needs replicas; revisit when p95 reads pass 50 ms.
`,
  },
  {
    id: "decisions/adr-002-edge-caching",
    age: 2880,
    content: `# ADR 002: Cache catalog reads at the edge

**Status:** Proposed · **Date:** 2026-08-28

## Context

Catalog pages are 70% of traffic and change a few times a day. The origin is in one region ([[architecture/overview]]).

## Decision

Cache \`GET /catalog/*\` for 5 minutes at the edge with surrogate keys, purged on write. Builds on [[decisions/adr-001-use-postgres]] — the purge is triggered from a Postgres \`NOTIFY\`.

## Open questions

- [ ] How do we purge per-org price overrides?
- [ ] Do we need stale-while-revalidate?
`,
  },
];

/** Folders that exist on disk but hold no notes. `list_knowledge` never lists
 *  a directory, only `.md` files, so these do not appear in the tree. */
export const SEED_EMPTY_DIRS = ["archive"];

/** `.atlas/knowledge/_meta.json`. Notes without an entry fall back to their
 *  filename, which is what Rust sends as the wire title. */
export const SEED_META: Record<string, RustPageMeta> = {
  welcome: {
    icon: "👋",
    title: "Welcome to acme-app",
    cover: "covers/welcome.png",
    status: "Published",
    tags: ["start-here"],
    owner: "priya",
    created_at: ago(60 * 24 * 90),
    updated_at: ago(4),
  },
  "architecture/overview": {
    icon: "🏗️",
    title: "Architecture overview",
    cover: "gradient:dusk-1",
    status: "Published",
    tags: ["architecture", "infra"],
    owner: "marco",
    created_at: ago(60 * 24 * 60),
    updated_at: ago(45),
  },
  "architecture/auth-flow": {
    icon: "🔐",
    title: "Auth flow",
    status: "RFC",
    tags: ["auth", "security", "passkeys"],
    owner: "priya",
    created_at: ago(60 * 24 * 30),
    updated_at: ago(95),
  },
  "architecture/data-model": {
    icon: "🗄️",
    title: "Data model",
    tags: ["database"],
    created_at: ago(60 * 24 * 45),
    updated_at: ago(300),
  },
  "guides/debugging-guide": {
    icon: "🐛",
    title: "Debugging guide",
    status: "Draft",
    tags: ["ops", "on-call"],
    owner: "sam",
    created_at: ago(60 * 24 * 7),
    updated_at: ago(20),
  },
  "guides/onboarding": {
    icon: "🧭",
    title: "Onboarding handbook",
    status: "Published",
    tags: ["people"],
    owner: "dana",
    created_at: ago(60 * 24 * 120),
    updated_at: ago(600),
  },
  "guides/setting-up-local-dev": {
    icon: "💻",
    title:
      "Setting up a reproducible local development environment on Apple Silicon with Docker, Postgres and seeded fixtures",
    tags: ["setup"],
    created_at: ago(60 * 24 * 20),
    updated_at: ago(1440),
  },
  "decisions/adr-001-use-postgres": {
    icon: "📜",
    title: "ADR 001: Use Postgres",
    status: "Archived",
    tags: ["adr", "database"],
    owner: "marco",
    created_at: ago(60 * 24 * 200),
    updated_at: ago(4320),
  },
  "decisions/adr-002-edge-caching": {
    title: "ADR 002: Edge caching",
    status: "RFC",
    tags: ["adr", "performance"],
    owner: "marco",
    created_at: ago(60 * 24 * 21),
    updated_at: ago(2880),
  },
};

const reposDir = `${MOCK_WORKSPACE.path}/.atlas/repos`;

export const SEED_REPOS: ClonedRepo[] = [
  {
    name: "acme-design-tokens",
    display_name: "acme/design-tokens",
    path: `${reposDir}/acme-design-tokens`,
    has_readme: true,
    branch: "main",
    meta: {
      description: "Colour, type and spacing tokens shared by every Acme front end.",
      language: "TypeScript",
      stars: 128,
      forks: 14,
      html_url: "https://github.com/acme/design-tokens",
      updated_at: "2026-09-10T08:30:00Z",
    },
  },
  {
    name: "tokio-rs-mini-redis",
    display_name: "tokio-rs/mini-redis",
    path: `${reposDir}/tokio-rs-mini-redis`,
    has_readme: false,
    branch: null,
    meta: null,
  },
];

export const SEED_READMES: Record<string, string> = {
  "acme-design-tokens": `# @acme/design-tokens

Colour, type and spacing tokens shared by every Acme front end, generated from one source of truth.

## Install

${F}bash
bun add @acme/design-tokens
${F}

## Usage

${F}ts
import { color, space } from "@acme/design-tokens";

export const card = { padding: space[4], background: color.surface.raised };
${F}

## Tokens

| Group | Example | Notes |
| --- | --- | --- |
| \`color\` | \`color.text.primary\` | Light and dark values |
| \`space\` | \`space[4]\` → \`16px\` | 4px grid |
| \`radius\` | \`radius.md\` → \`8px\` | |

## Contributing

1. Edit \`tokens/*.json\`.
2. Run \`bun run build\` to regenerate the CSS and TS outputs.
3. Open a PR; the visual diff job posts screenshots.

> Tokens are versioned with semver. Renaming a token is a breaking change.
`,
};

/** A stand-in cover image: an SVG landscape whose hue comes from the ref, so
 *  different covers look different. Rust would return the real file's bytes. */
export function coverSvgDataUrl(ref: string): string {
  let hash = 0;
  for (const ch of ref) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const h = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="hsl(${h} 55% 72%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 60% 88%)"/>
</linearGradient></defs>
<rect width="1200" height="360" fill="url(#s)"/>
<circle cx="930" cy="110" r="46" fill="hsl(${(h + 30) % 360} 90% 96%)"/>
<path d="M0 260 L180 150 L330 230 L520 110 L700 240 L880 160 L1200 270 L1200 360 L0 360Z" fill="hsl(${h} 30% 42%)"/>
<path d="M0 300 L220 220 L420 290 L640 200 L860 290 L1040 230 L1200 300 L1200 360 L0 360Z" fill="hsl(${h} 30% 28%)"/>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
