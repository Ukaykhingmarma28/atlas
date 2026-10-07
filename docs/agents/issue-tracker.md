# Issue tracker: Linear (internal) + GitHub Issues (community)

The two trackers split by **audience**, not by function:

- **Linear** is where the team plans and tracks its own work. Use the Linear connector to read and write it.
- **GitHub Issues** is where outside contributors report bugs and pitch features — the in-app feedback button and `CONTRIBUTING.md`'s "open an issue first" both route there. It carries `good first issue` / `help wanted` for community pickup, and GitHub is the pull-request and release surface.

Link a Linear issue to its GitHub branch or PR when implementation begins. Mirroring Linear → GitHub is one-way and selective: someone opens a matching GitHub issue only for work worth advertising to outside help.

## Teams

| team       | key   | holds                                                                                                                           |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Atlas**  | `ATL` | product and engineering work, and the people-written notes that steer it                                                        |
| **Growth** | `GRO` | intake records about outside people: enterprise leads, beta-tester signups, credits requests. Scripts and forms file them here. |

Product work goes to Atlas. A record about a person or company outside the team goes to Growth, never Atlas: agents search Atlas to find work, and every lead there is noise in that search.

## Labels

Four **groups**, each single-select, so an issue carries at most one label from each:

| group         | labels                                                                                                   | set it when                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**      | `Bug` · `Feature` · `Improvement` · `Chore` · `Research` · `Content`                                     | always                                                                                                                                                                                              |
| **Area**      | `Desktop` · `Web` · `Cloud` · `Agent runtime` · `Design system` · `Docs & site` · `Release` · `Business` | always, for the part of Atlas the work mainly touches                                                                                                                                               |
| **Readiness** | `ready-for-agent` · `needs-decision` · `needs-spec`                                                      | on open work. `ready-for-agent`: decision-complete, an agent can implement it unaided. `needs-decision`: a human must pick between stated options. `needs-spec`: the outcome itself is still vague. |
| **Origin**    | `handwritten` · `agent-written`                                                                          | always. `agent-written` when an agent drafted the issue, even if a person filed it.                                                                                                                 |

`Chore` is work with no user-visible change (refactors, provisioning, CI, dependency bumps). `Research` is a question to answer or a decision to make before building. `Content` is writing or media for people outside the codebase.

Ungrouped labels mark a **family** of issues to pull up as a set; each label's description in Linear says what qualifies: `acp-stack`, `zed-port`, `resource-leak`, `misreports-to-user`, and the `wayfinder:*` labels the wayfinder skill applies. `tracker` marks a person's running log or status note (below). Read a label's description before applying it; create a new label only when the user asks.

## Writing an issue

An agent-written issue is read by the next agent, so write it to be picked up cold:

- **Title**: the outcome, in plain words. Prefix the surface in brackets when the project spans several (`[desktop]`, `[web]`).
- **Body**: the `to-tickets` / `to-spec` shape — `## Parent` (when it has one), `## What to build`, acceptance criteria, and the files or crates involved. Link the parent issue, the spec, and any ADR by identifier.
- **Fields**: team, project, all four label groups, and a parent when it is one slice of a larger issue. Leave assignee empty unless the user names one.
- **Size**: one deliverable per issue. A body of work with slices is a parent issue whose children are the slices; a body of work with its own goal and timeline is a **project**.

**Handwritten** issues are the founders' and the team's own voice: direction, notes for each other, half-formed ideas. Leave their wording alone. Label them, link them, and ask before rewriting or splitting one.

## Status updates go in project updates

A progress report belongs in the project's **Updates** tab (or an initiative update), where Linear tracks health over time, not in an issue. An existing issue that is really someone's running log carries `tracker`; agents leave `tracker` issues out of work queues and never close one.

## Operating rules

- Statuses: Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate.
- Bulk changes — status, labels, project, priority, assignee, team or relations on more than a handful of issues — need the user's explicit go-ahead first, with the planned diff shown.
- Read an issue before updating it, and confirm its identifier and the intended change.
- Close a GitHub issue as soon as its fix merges into the version branch (see "Branching model" in `CONTRIBUTING.md`). `Fixes #N` only auto-closes on merges into `main`, so the merger closes it by hand with a comment naming the PR and branch.

## Linear features, and what each one is for here

Use the structure Linear already has before inventing one in issue bodies. Each row is the job, then the feature that does it.

| job                                                        | feature                                 | how we use it                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| a goal spanning several projects                           | **Initiatives**                         | one per pillar or launch; projects hang off it, and its updates roll up the projects'                                                                |
| a body of work with a goal and an end                      | **Projects** + **milestones**           | milestones are the phases ("Phase 01", "post-cohort"), never a separate project per phase                                                            |
| "where are we" reporting                                   | **Project / initiative updates**        | weekly, with a health (on track / at risk / off track). Ask Linear Agent (⌘J) to draft one from the project's activity                               |
| a time-boxed batch of work                                 | **Cycles**                              | when the team commits to a sprint; an issue in a cycle is a promise                                                                                  |
| a spec, PRD, decision record or notes longer than an issue | **Documents**, attached to the project  | link to it from the issues; the repo's ADRs stay in `docs/adr/`                                                                                      |
| a request from an outside person or company                | **Customers** + **customer requests**   | an enterprise lead becomes a Customer; the issues they ask for carry a request, so "most-asked" is a sort, not a guess                               |
| a repeatable issue shape                                   | **Templates**                           | bug report, wayfinder question, beta signup: the template sets the labels and sections                                                               |
| a saved slice of the backlog                               | **Custom views**                        | `Agent queue` (ready-for-agent, open), `Needs a human` (needs-decision or needs-spec), `Handwritten` (the founders' notes)                           |
| conventions every agent should follow                      | **Agent guidance** (workspace and team) | Settings → Agents → Additional guidance: a short pointer to this file's rules. Linear passes it to every agent that works an issue                   |
| a workflow run the same way each time                      | **Linear Agent skills** (Loops later)   | team-shared skills (e.g. "triage the backlog", "draft the weekly update"). Loops, which run a skill on a schedule or trigger, need the Business plan |
| handing an issue to an agent                               | **Delegate** (assign to an agent)       | the human stays the owner; filter views by Delegate to see what agents hold. Coding sessions spend the workspace's AI credits                        |
| incoming work from outside the team                        | **Triage**                              | on for Growth, so form submissions land in a queue to accept or decline. Triage rules, Triage Intelligence and Asks need the Business plan           |

## When a skill says…

- **"publish to the issue tracker"**: create a Linear issue on the Atlas team, following "Writing an issue".
- **"fetch the relevant ticket"**: read that Linear issue with the connector.
