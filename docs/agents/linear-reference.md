# Linear reference

Look-ups for [`issue-tracker.md`](issue-tracker.md): the teams, labels, projects and views, and which Linear feature does which job.

## Teams

| team       | key   | holds                                                                                                                               |
| ---------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Atlas**  | `ATL` | product and engineering work, and the people-written notes that steer it                                                            |
| **Growth** | `GRO` | records about outside people and companies: enterprise leads, beta-tester signups, credits requests, outreach. Forms file them here |

Agents search Atlas to find work, so a lead filed there is noise in every search.

## Labels

Four **groups**, each single-select:

| group         | labels                                                                                                   | set it when                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**      | `Bug` · `Feature` · `Improvement` · `Chore` · `Research` · `Content`                                     | always                                                                                                                                                                                              |
| **Area**      | `Desktop` · `Web` · `Cloud` · `Agent runtime` · `Design system` · `Docs & site` · `Release` · `Business` | always, for the part of Atlas the work mainly touches                                                                                                                                               |
| **Readiness** | `ready-for-agent` · `needs-decision` · `needs-spec`                                                      | on open work. `ready-for-agent`: decision-complete, an agent can implement it unaided. `needs-decision`: a human must pick between stated options. `needs-spec`: the outcome itself is still vague. |
| **Origin**    | `handwritten` · `agent-written`                                                                          | always. `agent-written` when an agent drafted the issue, even if a person filed it.                                                                                                                 |

`Chore` is work with no user-visible change (refactors, provisioning, CI, dependency bumps). `Research` is a question to answer or a decision to make before building. `Content` is writing or media for people outside the codebase. Readiness belongs to the Atlas team, so it is dropped when an issue moves to Growth.

Ungrouped labels mark a **family** to pull up as a set; each one's description in Linear says what qualifies: `acp-stack`, `zed-port`, `resource-leak`, `misreports-to-user`, and the `wayfinder:*` labels the wayfinder skill applies. `tracker` marks a person's running log.

## Projects

Each project has a lead, a summary, a status and, where one exists, its spec under Resources. Pick by subject:

| project                         | holds                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| **Agents & ACP**                | the native engine, installed ACP agents, the agent store, MCP across agents        |
| **Claude Code parity**          | surfacing Claude Code's terminal features for the installed Claude agent (ATL-845) |
| **AI Gateway & metering**       | model access, entitlements, metering, the catalogue, spend alarms, model runbooks  |
| **Atlas Sync/Project Unison**   | session capture, sync and the Timeline                                             |
| **Atlas Session Artifacts**     | sessions, tool calls and checkpoints synced into the organisation                  |
| **Atlas Shared Threads**        | live multiplayer agent threads                                                     |
| **Atlas Team Chat**             | chat, calls, assets and prompt drafts                                              |
| **Atlas Spaces**                | the shared canvas per conversation                                                 |
| **Issues & Organisation agent** | pillar 3: issue tracking, sprints and an org-aware agent. Ideas until it starts    |
| **Handbook**                    | pillar 4: the team's living knowledge base                                         |
| **Atlas Design System**         | tokens, the package, Storybook and the desktop redesign, by milestone              |
| **Desktop polish**              | small desktop UX fixes with no feature home                                        |
| **Desktop builds & release**    | Linux and Windows builds, early builds for testers                                 |
| **Launch & beta**               | docs, Atlas Learn videos, the beta programme, articles, launch posts               |
| **Atlas Maintenance**           | defects and debt with no feature home (ATL-212 and its children)                   |

## Views

Saved views (sidebar → Views) are the team's shared slices: `Agent queue` (open, `ready-for-agent`), `Needs a human` (`needs-decision` or `needs-spec`), `Handwritten`, `In review`, `Stuck` (started, untouched for 14 days), and `Shipped this week`. Filter a view by **Delegate** to see what agents hold.

## Linear features, and what each one is for here

| job                                              | feature                                 | how we use it                                                                                                               |
| ------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| a goal spanning several projects                 | **Initiatives**                         | one per pillar, plus go-to-market; projects hang off them and their updates roll up                                         |
| a body of work with a goal and an end            | **Projects** + **milestones**           | milestones are the phases ("M0 · Decisions"), never a separate project per phase                                            |
| "where are we" reporting                         | **Project / initiative updates**        | with a health. Ask Linear Agent (⌘J) to draft one from the project's activity                                               |
| a time-boxed batch of work                       | **Cycles**                              | off for now; turn on when the team commits to sprints                                                                       |
| a spec, PRD, runbook, decision or direction note | **Documents**, attached to the project  | link to it from the issues; the repo's ADRs stay in `docs/adr/`                                                             |
| a request from an outside person or company      | **Customers** + **customer requests**   | an enterprise lead becomes a Customer; the issues they ask for carry a request                                              |
| a repeatable issue shape                         | **Templates**                           | bug report, agent-written slice, Growth record: the template sets the labels and sections                                   |
| conventions every agent should follow            | **Agent guidance** (workspace and team) | Settings → Agents → Additional guidance: a short pointer to these docs. Linear passes it to every agent that works an issue |
| handing an issue to an agent                     | **Delegate**                            | the human stays the owner. Coding sessions spend the workspace's AI credits                                                 |
| incoming work from outside the team              | **Triage**                              | on for Growth. Triage rules, Triage Intelligence, Asks and Loops need the Business plan                                     |
| linking branches and PRs to issues               | **GitHub integration**                  | not yet connected: ATL-940                                                                                                  |
