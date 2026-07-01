# Spec — Build, Conventions & Stack

Authority on the build system, enforced coding standards, and model assets.
Sources: `nx.json`, `package.json`, `apps/*/project.json`, `CODING_STANDARDS.md`,
`apps/frontend/public/models/README.md`, `STACK.md`.

## Monorepo & tooling

- **Nx 22.7.1** monorepo. `workspaceLayout`: apps in `apps/`, libs in `packages/`.
- Task runner: **Nx Cloud** (`nxCloudId` set); `build`/`test`/`lint` cacheable.
- Inferred-target plugins: `@nx/js/typescript` (typecheck/build), `@nx/eslint` (lint),
  `@nx/vite` (build/serve/dev/preview/test), `@nx/vitest`.

## Projects & targets

| Project  | Name            | Key targets                                                                                                                   |
| -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Frontend | `@org/frontend` | `build` (`@nx/vite:build` → `dist/apps/frontend`), `serve`, `typecheck`, `lint`, `test`, `docker-build` (`sentinel-frontend`) |
| Backend  | `backend`       | `serve`, `test`, `lint`, `docker-build` (`sentinel-backend`) — see `backend-api.md`                                           |

Naming is inconsistent (`@org/frontend` scoped vs. bare `backend`).

### Run commands (verified against `docs/PROJECT.md` + `project.json`)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # node@22 required or Nx fails
npx nx serve @org/frontend       # dev server
npx nx typecheck @org/frontend   # type-check
npx nx build @org/frontend       # production build
```

## Dependency manifest (`package.json`)

Runtime: `react@19`, `react-dom@19`, `react-router-dom@6.30.3`, `three@0.184`,
`3d-tiles-renderer@0.4.28`, `tailwindcss@4` + `@tailwindcss/vite`, `daisyui@5`,
`dotenv@17`. Dev: Nx 22 plugins, `vite@8`, `vitest@4` (+ coverage/ui),
`@testing-library/*`, `typescript@5.9`, `typescript-eslint@8`, `@types/three`.
`@nxlv/python` provides Python project support.

## Coding standards (`CODING_STANDARDS.md`, CI-enforced — ESLint errors block PRs)

- **Type safety**: no `any`, explicit function return types, explicit member
  accessibility, strict boolean expressions (all errors); no non-null assertion (warn).
- **Async**: no floating promises / await-thenable / no misused promises (errors).
- **Quality**: `no-console` except `warn`/`error`; `eqeqeq`; no magic numbers (warn);
  prefer-const; prefer arrow callbacks; no empty functions.
- **Naming**: camelCase vars/fns, PascalCase types/classes, UPPER*SNAKE constants,
  `*`-prefix unused.
- **React**: no array-index keys; self-closing components; rules-of-hooks;
  exhaustive-deps (warn); jsx-a11y alt-text.
- **Imports**: ordered groups; **`import/no-cycle` (error)**.
- **Prettier**: single quotes, semicolons, 2-space, 100 columns, ES5 trailing commas,
  LF. `npm run format` / `nx format:check`.

The three most recent commits on `feat/software-revamp` are lint-compliance fixes,
confirming the standard is actively enforced.

## Model assets (`apps/frontend/public/models/`)

Placeholder-quality GLBs (auto-normalised on load; missing → primitive fallback):

| File       | Used for                      | Source                     | License                               |
| ---------- | ----------------------------- | -------------------------- | ------------------------------------- |
| `tank.glb` | Player tank + hostile AFV     | Cesium `GroundVehicle.glb` | Apache-2.0                            |
| `car.glb`  | Player car + hostile LMV      | three.js `ferrari.glb`     | MIT repo (model: Carlo Crisci / DEZA) |
| `jet.glb`  | Player jet + hostile aircraft | Cesium `Cesium_Air.glb`    | Apache-2.0                            |

Convention: models face **+Z**; set `rotationY` in `modelCatalog.ts` to correct
orientation. Licenses MUST be checked before shipping any model in a public demo.

## Host stack pointer

`STACK.md` (repo root) is the canonical machine/agent-facing stack declaration the
harness's generic specialists read. This spec and `STACK.md` MUST agree; `STACK.md` is
authoritative for the harness's stack-detection.

## Invariants (do not regress)

- `import/no-cycle` is an error — module extractions that exist to break cycles (e.g.
  `vehicleBase.ts`) MUST NOT be merged back.
- Lint/type/format gates are CI-blocking; new code lands clean (per
  `.claude/rules/zero-tolerance.md`).
