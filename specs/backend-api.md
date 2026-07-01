# Spec — Backend API

Authority on the backend as it exists today. Source: `apps/backend/`.

This spec describes the **current** backend surface, which is minimal. Intended future
backend work is tracked in `workspaces/sentinel/02-plans/`, not here.

## Surface

`apps/backend/app/main.py` is the entire application (`main.py:1-18`):

- A FastAPI app instance.
- One route: `GET /` → `{"message": "FastAPI is running!"}` (`main.py:7-9`).
- CORS middleware registered with `allow_origins=["*"]`, `allow_credentials=True`,
  `allow_methods=["*"]`, `allow_headers=["*"]` (`main.py:12-18`).

There are **no** other routes, no data models, no database, no authentication, and no
persistence. The frontend does not call the backend — the only outbound network calls
from the frontend are to Google (tiles) and OpenStreetMap (labels)
(verified: the sole `fetch(` in `apps/frontend/src` is the Google tiles preflight,
`createSandbox.ts:138`).

## Runtime & dependencies

`apps/backend/requirements.txt`: `fastapi==0.136.1`, `uvicorn==0.46.0`,
`python-dotenv==1.2.2`, `pytest==9.0.3`. Served on port 8000 with `--reload`.

## Nx wiring (`apps/backend/project.json`)

| Target         | Command                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `serve`        | resolves `.venv` python via `tools/python-server.js`, then `uvicorn app.main:app --reload --port 8000` |
| `test`         | `node tools/python-tester.js` (no `test_*.py` files exist)                                             |
| `lint`         | `node tools/python-linter.js`                                                                          |
| `docker-build` | `docker build -t sentinel-backend -f docker/backend.DockerFile .`                                      |

`tools/python-{server,linter,tester}.js` are Node shims that select the platform-correct
`.venv/bin/python` (or `Scripts/python.exe` on Windows). `apps/backend/cloudflared-config.yaml`
is a Cloudflare tunnel config.

## Current behavioral notes (factual, today)

- The CORS middleware combination `allow_origins=["*"]` + `allow_credentials=True` is
  rejected by browsers for credentialed requests (a standards constraint). Since no
  frontend code makes credentialed calls to the backend, this has no user-visible effect
  today, but it is a latent defect (tracked as G6 in the gap register).
- `add_middleware` is registered after the route definition in the module body; it still
  applies because both run at import time.

## Invariants (today)

- The backend currently performs **no simulation, persistence, or detection work** — all
  user-visible capability is frontend-only. Any spec section claiming otherwise would be
  inaccurate until such code lands on `main`.
