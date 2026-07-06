---
declared_stack: typescript
secondary_stacks: [python]
detected_at: 2026-06-30T00:00:00Z
confidence: HIGH
detector_version: manual-onboard-1.0
evidence:
  - package.json (react@19, three@0.184, 3d-tiles-renderer@0.4.28, vite@8, nx@22.7.1, vitest@4, typescript@5.9)
  - nx.json (@nx/vite, @nx/vitest, @nx/eslint, @nx/js/typescript plugins; apps in apps/, libs in packages/)
  - apps/frontend/project.json (@org/frontend, @nx/vite:build → dist/apps/frontend)
  - apps/backend/requirements.txt (fastapi==0.136.1, uvicorn==0.46.0, python-dotenv==1.2.2, pytest==9.0.3)
  - apps/backend/project.json (uvicorn serve via .venv; node tools/python-*.js shims)
notes: |
  Polyglot Nx 22 monorepo for Project Sentinel (a browser 3D tactical COP).

  PRIMARY — TypeScript (apps/frontend, ~5,250 LOC): React 19 + Vite 8 SPA, a
  Three.js engine streaming Google Photorealistic 3D Tiles (3d-tiles-renderer).
  This is the bulk of the codebase and where every user-visible capability lives.
    - Package manager: npm (package-lock.json committed; npm workspaces)
    - Test runner: Vitest 4 (+ @testing-library/react, jsdom). Run via `nx test @org/frontend`.
    - Type-check: `nx typecheck @org/frontend` (tsc 5.9, strict standards in CODING_STANDARDS.md).
    - Lint/format: ESLint 9 (typescript-eslint 8, strict) + Prettier 3. `nx lint`, `nx format:check`.
    - Build: `nx build @org/frontend` → dist/apps/frontend (Vite).
    - GOTCHA: requires node@22 on PATH or Nx fails (docs/PROJECT.md).

  SECONDARY — Python (apps/backend, ~18 LOC): a thin FastAPI app (root endpoint +
  CORS only; no routes/models/persistence yet). Far less developed than the frontend.
    - Test runner: pytest 9 (no test files exist yet).
    - Serve: `nx serve backend` → uvicorn app.main:app --reload --port 8000 (via .venv).
    - NOTE: backend uses plain requirements.txt; the harness's python-environment.md
      expects uv + pyproject.toml + .venv. Reconciliation tracked in
      workspaces/sentinel/02-plans/02-gap-remediation-backlog.md (G13).

  PROVENANCE: this STACK.md was authored during the 2026-06-30 /analyze onboarding
  pass from a live read of the manifests listed in `evidence` (not copied from
  another repo). To regenerate via the canonical stack-detector agent, run
  /onboard-stack (it will refresh detected_at + detector_version).
---

# STACK.md — Project Sentinel

Machine/agent-facing host-stack declaration read by the harness's generic specialists
(`db-specialist`, `api-specialist`, `ai-specialist`) and `decide-framework` before they
advise. See `.claude/rules/stack-detection.md` for the schema contract. The
human-readable companion is `specs/build-conventions-and-stack.md`; the two must agree.
