# Spec — Backend API

Authority on the backend as it exists today. Source: `apps/backend/`.

## Surface

`apps/backend/app/main.py` builds the FastAPI app. Two routes exist:

- `GET /` → `{"message": "FastAPI is running!"}` (`main.py:116-118`).
- `POST /api/v1/detect` (`app/routes/detect.py`) — the auto-detect pipeline the frontend's
  Intel Import / Detect Debug tools call (see `intel-import-and-detections.md`
  § Auto-detect pipeline). The frontend **does** call the backend today — this is the
  only endpoint it calls.

Cross-cutting middleware (`main.py:46-113`):

- **CORS**: origins come from `Settings.cors_origins`, never a literal `["*"]` —
  `config.py`'s `cors_origins` property raises `ValueError` at settings-load time if
  `CORS_ALLOWED_ORIGINS` contains `*` (a wildcard origin combined with
  `allow_credentials=True` would let any site read authenticated responses).
- **Body-size cap**: requests with `Content-Length` over `MAX_BODY_BYTES` (25MB) are
  rejected `413` before the body is read (`main.py:20,82-92`).
- **Request-ID + structured logging**: every request gets a `request_id` (bound via
  `structlog.contextvars`), logged at `request.start`/`request.ok`, echoed back as the
  `x-request-id` response header (`main.py:73-113`).
- **Typed error responses**: `HTTPException`, `RateLimitExceeded`, and any unhandled
  exception all render as flat `ErrorResponse` JSON (`error`, `detail`, `request_id`) —
  never a bare/opaque 500 (`main.py:55-105`, `.claude/rules/zero-tolerance.md` Rule 3).
- **Rate limiting**: `slowapi`, keyed by remote address; `/api/v1/detect` is capped at
  `20/minute` (`routes/detect.py:19,27`).

## `POST /api/v1/detect` contract

Request (`schemas.py::DetectRequest`): `image_b64` (base64, no data-URL prefix, capped at
`MAX_IMAGE_B64_CHARS` = 20M chars ≈ 15MB decoded), optional `pose` (`ImagePose`: lat/lon/
alt_m/heading_deg/pitch_deg — the only pose fields the detector prompt reads), optional
`image_meta` (width/height/name).

Response (`schemas.py::DetectResponse`): `annotations: list[DetectionBox]`, `model` (the
resolved model id or provider name), `latency_ms`. Each `DetectionBox` (`schemas.py:47-63`)
carries `id`, `cls`, `rear`/`front` (`Point2D` keypoints, not just a box), `half_width_px`
(wire alias `halfWidthPx` — byte-match with the frontend's `ImageAnnotation.halfWidthPx`,
`schemas.py:48-53`), `confidence` (`0.0-1.0`), `heading_confidence` (`'high'|'medium'|'low'`
— the same 3-value contract as `SentinelDetection.heading_confidence` in `detections.ts`).

Errors: `400 invalid_image` (malformed base64), `502 detector_unavailable` (any
`DetectorError` from the provider — malformed response, provider failure, out-of-contract
output; never a silent empty/fabricated result), `413 payload_too_large`, `429 rate_limited`,
`500 internal_error` (unexpected).

## Detector abstraction (`app/detector/`)

`Detector` (`base.py:12-22`) is a provider-agnostic ABC — one `async detect(image_bytes,
pose) -> list[DetectionBox]` method, raising `DetectorError` on any failure. `get_detector
(settings)` (`base.py:25-52`) is the **only** place a provider name is switched on:

- `detector_provider: "stub"` → `StubDetector` (fixture responses, no tiling — tiling a
  fixture serves no purpose).
- `detector_provider: "vlm-local" | "vlm-api"` → `VisionLanguageModelAdapter` (an
  OpenAI-compatible vision-language-model endpoint — local via Ollama, or a hosted API),
  wrapped in `TilingDetector` when `detector_tiling_enabled` is true (default).

`TilingDetector` (`detector/tiling.py`) splits the capture into overlapping tiles before
detection — the fix for the imprecise/inconsistent full-image coordinates traced in
`workspaces/sentinel/journal/0008`-`0011`; it is a modifier over whichever provider adapter
was selected, not a provider itself.

## Config (`app/config.py`, pydantic-settings, sourced from `.env`)

| Var                         | Default                                                            | Notes                                                                                      |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `DETECTOR_PROVIDER`         | `vlm-local`                                                        | `stub` \| `vlm-local` \| `vlm-api`                                                         |
| `DETECTOR_MODEL`            | per-provider (`qwen2.5vl:3b` for `vlm-local`, empty for `vlm-api`) | resolved via `resolved_detector_model`                                                     |
| `DETECTOR_BASE_URL`         | per-provider (`http://localhost:11434/v1` for `vlm-local`)         | resolved via `resolved_detector_base_url`                                                  |
| `DETECTOR_API_KEY`          | unset                                                              | only needed for `vlm-api`                                                                  |
| `DETECTOR_REASONING_EFFORT` | unset                                                              | `low`\|`medium`\|`high` — only for reasoning-capable models (o-series, gpt-5.x)            |
| `DETECTOR_OMIT_TEMPERATURE` | `false`                                                            | some models (e.g. gpt-5.5) reject an explicit `temperature` regardless of reasoning_effort |
| `DETECTOR_TILING_ENABLED`   | `true`                                                             | set `false` to fall back to the untiled single-shot path                                   |
| `CORS_ALLOWED_ORIGINS`      | `http://localhost:4200`                                            | comma-separated explicit origins, never `*`                                                |

## Runtime & dependencies

`apps/backend/pyproject.toml` + `uv.lock` (uv-managed, NOT `requirements.txt` — that file no
longer exists): `fastapi>=0.136`, `uvicorn[standard]>=0.46`, `pydantic>=2.0`,
`pydantic-settings>=2.0`, `python-dotenv>=1.2`, `structlog>=24.0`, `slowapi>=0.1`,
`httpx2>=0.1`, `pillow>=11.0` (tiling image manipulation). Dev: `pytest>=9.0`,
`pytest-asyncio>=0.24`, `ruff>=0.8`. Served on port 8000 with `--reload`. Requires Python
`>=3.12`.

## Nx wiring (`apps/backend/project.json`)

| Target         | Command                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `serve`        | resolves `.venv` python via `tools/python-server.js`, then `uvicorn app.main:app --reload --port 8000` |
| `test`         | `node tools/python-tester.js` (runs `apps/backend/tests/*.py` via `uv run pytest`)                     |
| `lint`         | `node tools/python-linter.js`                                                                          |
| `docker-build` | `docker build -t sentinel-backend -f docker/backend.DockerFile .`                                      |

`tools/python-{server,linter,tester}.js` are Node shims that select the platform-correct
`.venv/bin/python` (or `Scripts/python.exe` on Windows). `apps/backend/cloudflared-config.yaml`
is a Cloudflare tunnel config.

## Invariants (today)

- `get_detector()` is the sole provider-switch seam — adding a new provider means adding a
  branch there; nothing else in the app changes.
- Every detector failure raises typed `DetectorError`, surfaced as `502
detector_unavailable` — never a silent empty or fabricated detection list.
- CORS origins are never a literal wildcard while `allow_credentials=True` is set — enforced
  at settings-load time, not just documented.
- Every response (success or error) carries `request_id`; every error body is the flat
  `ErrorResponse` shape.
