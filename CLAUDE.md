<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Project Sentinel

A browser-based 3D tactical common operating picture (COP): a Three.js engine streaming
Google Photorealistic 3D Tiles, with player vehicles/ordnance, a hidden-movement "Spider-Man
mode", strategist recon tools, and an imagery-to-world intel-import pipeline. Polyglot Nx
monorepo — TypeScript frontend (`apps/frontend`, the bulk of the code) + a thin Python/FastAPI
backend (`apps/backend`). Full detail: `STACK.md` (machine-facing stack declaration) and
`specs/build-conventions-and-stack.md` (human-readable companion — the two must agree).

This repo **does** write code — unlike a COC orchestration root, Project Sentinel is the
downstream project the COC harness assists, not the harness's own source of truth.

## Where things live

- **`specs/`** — domain truth for what the system does today (see `specs/_index.md` for the
  8 domain files: engine/modes, tile streaming, vehicles/ordnance, Spider-Man mode, strategist
  tools, intel import, backend API, build conventions). Read `_index.md` first; it's the lookup
  table, not the specs themselves.
- **`workspaces/sentinel/`** — process state for the active workstream: `01-analysis/`,
  `02-plans/`, `03-user-flows/`, `todos/active/`, `journal/`, `.session-notes`. Gitignored by
  design (`/workspaces/*` in `.gitignore`) — this is local session state, not shipped history.
- **`STACK.md`** — the stack declaration the generic specialists (`db-specialist`,
  `api-specialist`, `ai-specialist`) and phase commands read before acting.

## COC phase commands available here

`/onboard-stack`, `/analyze`, `/todos`, `/implement`, `/redteam`, `/codify`, `/release`,
`/sweep`, `/journal`, `/wrapup`, `/ws`, `/test`, `/validate`, `/design`, `/deploy`, `/migrate`,
`/start`, `/learn`, `/certify`, `/i-audit`, `/i-polish`, `/i-harden`, `/claim`, `/claims`,
`/whoami`, `/onboard`, `/posture`. 52 rule files under `.claude/rules/` govern how these
commands operate (zero-tolerance, specs-authority, testing, security, git, agents, etc.) —
consult `.claude/rules/` when a command's behavior is unclear.
