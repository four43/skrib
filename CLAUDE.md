# Skrīb

Real-time collaboration app with WebAuthn/Passkey auth. FastAPI backend, vanilla JS frontend, SQLite DB, WebSocket messaging.

## Detailed Documentation

`docs/README.md` is the map. Docs live in three layers with different rules:
`docs/spec/` holds dated decision records (immutable — supersede, don't edit),
`docs/reference/` holds living docs (edit in place, must be true of `master`), and
`docs/legacy/` holds superseded material.

**Read `docs/spec/2026-08-02-roadmap-phases.md` before starting significant work** —
it states the three pillars (E2E encryption as inviolable, extensibility, user
experience), the current phase order, and what was deliberately cut.

Read these on demand when working on specific areas:

- **Backend API & structure**: `backend/README.md`
- **Frontend Web App architecture**: `frontend/README.md`
  - **WebAuthn testing via Playwright**: `docs/reference/playwright-webauthn-testing.md`
- **E2E encryption**: `docs/reference/end-to-end-encryption.md`
- **Plugin system & bus architecture**: `docs/reference/plugin-system.md`
- **Rooms, membership, roles**: `docs/reference/rooms-and-membership.md`
- **Auth flows**: `docs/reference/auth.md`
- **Live task list**: `TODO.md`
- **Plugins**: Each plugin has a `README.md` — read on demand when working on a specific plugin:
  - `backend/plugins/four43.room-type-chat/README.md` — Chat messaging (room type)
  - `backend/plugins/four43.room-type-todo/README.md` — Todo lists (room type)
  - `backend/plugins/four43.chat-typing/README.md` — Typing indicators (feature)
  - `backend/plugins/four43.message-reactions/README.md` — Emoji reactions (feature)
  - `backend/plugins/four43.web-push/README.md` — Web Push notifications (feature)

**IMPORTANT**: You MUST NOT create migration functions, we are in early development and will reset the database as needed. Just modify the schema and delete the `data/*` files to reset.

When a new feature is requested, YOU MUST write red/green tests first before implementing the feature.

## Project Structure

```
backend/skrib/       # FastAPI app
  auth/                  # WebAuthn registration/login
  rooms/                 # Chat rooms, DMs, IRC features (topic, roles)
  ws/                    # Unified WebSocket bus (single connection per client)
  room_folders/          # Nestable folder structure for rooms
  users/                 # User model, roles, profiles, avatars
  server/                # Server settings, invite tokens
  themes/                # Theme discovery and serving
  backups/               # Backup archives + scheduler
  admin/                 # Plugin approval admin API
  plugins/               # Plugin routes, middleware, settings
  plugin_bus/            # Out-of-process plugin bus (server, bridge, protocol, approvals, settings)
  database.py            # SQLite + WAL mode
  dependencies.py        # Auth middleware
  main.py                # App entry & router registration

backend/skrib_plugin_sdk/  # SDK for writing out-of-process plugins
  plugin.py              # SkribPlugin base class
  client.py              # WebSocket bus client
  bus.py                 # PluginBus (broadcast, notify, reply, emit)
  core_api.py            # CoreAPI client over bus frames
  database.py            # Plugin database helpers
  http.py                # HTTP server helper
  loader.py              # Plugin package loader

backend/plugins/         # Plugin implementations (each has backend/ + frontend/)
  four43.room-type-chat/ # Chat messaging (room type)
  four43.room-type-todo/ # Todo lists (room type)
  four43.chat-typing/    # Typing indicators (feature)
  four43.message-reactions/ # Emoji reactions (feature)
  four43.web-push/       # Web Push notifications (feature)
  four43.attachments/    # File attachments (feature)
  four43.emoji-picker/   # Custom emoji (feature)

data/                    # SQLite database files, clear these as needed for testing

frontend/pages/*.html    # HTML pages
frontend/src/            # Vanilla JS (Vite build)
  chat.js                # Main chat (WebSocket, rooms, DMs, messages)
  login.js / register.js # Auth pages
  utils.js               # Shared utilities
  style.css              # All styles
```

## Key Conventions

- Backend modules follow: `routes.py` (endpoints), `schemas.py` (Pydantic), `services.py` (logic)
- Frontend exposes functions via `window.{funcName}`
- Auth: WebAuthn credentials, session tokens in `Authorization: Bearer {token}`
- WebSocket auth via query param: `?token={sessionToken}`
- Messages use `?since={lastMessageId}` for deduplication (exclusive, returns id > since)
- Room deletion is a hard delete (removes room, memberships, keys, messages, etc.)
- First registered user is auto-approved as admin

## Room Types

- `GET /rooms` returns rooms (where user is a member), with `display_name` field
- There is no differentiation between DMs and Rooms
- Plugins handle the functionality of each different room type. They can register a room type, and users can
  collaborate in there.

## Unified WebSocket Bus

- Single WS connection per client at `WS /api/ws?token=...`
- **The namespace separator is a colon, not a dot.** Message types are
  `namespace:action` — `system:connected`, `room:message`. The dispatcher splits on
  `:` (`ws/handlers.py:44`, `ws/manager.py:263`).
- Three namespaces: `system:*` (connection-level), `room:*` (all room traffic), and
  `{plugin-id}:*` (e.g. `four43.chat-typing:start`)
- **User-scoped** events (`room:update`, `room:new_message`) go to all of a user's tabs
- **Room-scoped** events (`room:message`, `room:topic`) go only to tabs that sent `room:join`
- Client sends `room:join`/`room:leave` when switching rooms (no WS teardown)
- Messages sent via `room:message` (from client) or HTTP `POST /rooms/{room_id}/messages`
- Implementation in `backend/skrib/ws/` (manager.py, handlers.py, routes.py)

## Out-of-Process Plugin Bus

Plugins run as separate processes communicating over a WebSocket bus on port 9000. **The full reference for the bus protocol, permissions model, SDK API, and approval workflow is in `docs/reference/plugin-system.md`** — read that file before designing or modifying plugin behaviour. This section is just the orientation map:

> **This is changing.** `docs/spec/2026-08-02-extension-model.md` makes the process
> boundary a per-plugin `runtime: in_process | process` manifest field, with the same
> SDK either way, and `docs/spec/2026-08-02-core-log-and-signal.md` moves message
> storage into core. Read both before extending the bus.

- **Bus server** (`backend/skrib/plugin_bus/server.py`) — accepts plugin connections, enforces permissions, rate-limits, routes frames
- **Bridge** (`backend/skrib/plugin_bus/bridge.py`) — translates bus frames to/from the UnifiedConnectionManager and CoreAPI
- **Protocol** (`backend/skrib/plugin_bus/protocol.py`) — frame types, validation, permissions
- **Approvals** (`backend/skrib/plugin_bus/approvals.py`) — admin must approve new plugins before activation; manifest changes re-trigger approval
- **Settings** (`backend/skrib/plugin_bus/settings.py`) — typed plugin settings (server-scoped and user-scoped)
- **SDK** (`backend/skrib_plugin_sdk/`) — Python SDK for writing out-of-process plugins
- **Admin API** (`backend/skrib/admin/routes.py`) — `GET/POST/DELETE /api/admin/plugins/*` for approval management
- **Settings API** (`backend/skrib/plugins/settings_routes.py`) — `GET/PATCH /api/plugins/{id}/settings/*`

Each plugin has a `backend/plugin_bus.py` (SDK class) and `__main__.py` (entry point). There is no in-process fallback — `ws/handlers.py` dispatches every room action through the bus.

## Plugins — Frontend Build

Each plugin with a frontend is its own npm + Vite project under `backend/plugins/{id}/frontend/`:

```
frontend/
  src/plugin.js          # Source entry point
  vite.config.js         # Vite lib mode (IIFE output)
  package.json           # Plugin-specific deps + build/watch scripts
  dist/plugin.js         # Built output (gitignored)
```

Manifests reference the built output: `"entry": "frontend/dist/plugin.js"`.

Build orchestration lives in `frontend/util/`:
- `install-plugins` — installs deps in each plugin frontend (`npm ci` on a cold install, `npm install` to reconcile an existing `node_modules`)
- `build` — builds all plugins, then the main frontend
- `dev` — builds plugins once, starts `npm run watch` in each (background), then runs `vite` dev server

These are wired into the main frontend `package.json` scripts (`npm run dev`, `npm run build`).

## Running

Python dependencies are managed by **uv** from `backend/uv.lock`.
`./util/install-dependencies` is a thin wrapper over `uv sync` that takes an
optional comma-separated list of extras. It installs with
`--no-install-project`, so `skrib` and `skrib_plugin_sdk` are imported from the
source tree (via cwd or `PYTHONPATH`), not from site-packages.

```bash
# Backend (creates backend/.venv, which the e2e harness finds automatically)
cd backend && ./util/install-dependencies dev
cd backend && .venv/bin/python -m uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000

# Out-of-process plugins (optional — connects to bus on port 9000)
cd backend && ./util/start-plugins          # start all plugin processes
cd backend && ./util/start-plugins --stop   # stop all plugin processes

# Frontend (installs plugin deps, builds plugins, starts dev server)
cd frontend && npm install && ./util/install-plugins && npm run dev  # port 5173

# Docker — builds the production image and serves the built frontend on :8000
docker compose up --build
```

## Docker & Devcontainer

`Dockerfile` is multi-stage: `base → {plugin-pkg, fe-deps → fe-build} → py-deps →
dev → runtime`. Design notes in
`docs/specs/2026-08-02-docker-multistage-nonroot-design.md`.

- **`runtime` is the last stage**, so a build with no `--target` fails closed to
  the production image: non-root uid-1000 `app-user`, Python plus the built
  `frontend/dist` only — no Node, npm, uv, git, or sudo. It serves the frontend
  via FastAPI `StaticFiles`, so production genuinely needs no Node.
- **`dev` is the devcontainer target** (`build.target: dev`). Same uid-1000
  `app-user`, plus passwordless sudo and every dev tool baked into the image —
  nothing is apt-installed at container-create time.
- **`docker-compose.yml` runs the production image** with no source mount, so it
  doubles as a production smoke test. All dev behaviour lives in
  `.devcontainer/docker-compose.override.yml`.
- **`node_modules` are container-side named volumes**, seeded from the dev image
  and layered over the `./:/workspace` bind mount, so host and container installs
  stay separate. **Adding a plugin frontend means adding a volume line** (one per
  `node_modules` tree) to `.devcontainer/docker-compose.override.yml`.
  `on-create.sh` reconciles a stale volume with `npm install`; to reset one
  entirely, `docker volume rm skrib-node-modules-<name>`.
- **Never bind-mount a host dir over the container's `/tmp`** — under a non-root
  user it deadlocks devcontainer setup with no error message. Host scratch access
  is at `/host/tmp`.

## Testing

You MUST USE ./util/test-e2e for E2E tests, it sets SKRIB_TEST_DATA_DIR and builds the frontend. Each test gets an isolated backend + temp SQLite DB, so they are fully parallel-safe. WebAuthn is handled via CDP virtual authenticators (Chromium only). Don't run `npx playwright test` directly., it won't set up the environment correctly.

```bash
# E2E tests (builds frontend, spawns isolated backends per test)
cd frontend && ./util/test-e2e                              # run all e2e tests
cd frontend && ./util/test-e2e tests/e2e/core.spec.js       # run a specific test file
cd frontend && ./util/test-e2e --grep "room members"        # filter by test name

# DOM/unit tests
cd frontend && ./util/test

# Plugin bus unit tests (bus server, bridge, SDK, approvals, settings)
cd backend && python -m pytest tests/unit/plugin_bus/ -v
```

- E2E tests live in `frontend/tests/e2e/*.spec.js`, fixtures in `frontend/tests/e2e/fixtures.js`
- Always use `./util/test-e2e` for e2e tests — it sets `SKRIB_TEST_DATA_DIR` and builds the frontend
- Each e2e test gets its own backend + temp SQLite DB (fully isolated, parallel-safe)
- WebAuthn is handled via CDP virtual authenticators (Chromium only)
- **Debugging single tests**: Use `SKRIB_TEST_DATA_DIR=1 npx playwright test --project=e2e --grep "test name" --reporter=line` after building (`npm run build`) for verbose output including console.log
- **Frontend deps must be installed** before running tests: `npm install && ./util/install-plugins`
- **Worktree note**: In git worktrees, the backend venv lives in the main repo but `PYTHONPATH` is set to the worktree's backend, so worktree code changes take effect in tests

## Debugging

- Backend logs: `[WS]`, `[HTTP]`, `[DEBUG]` prefixes in console
- Frontend logs: `[WS]`, `[HTTP]` in browser console
- WebSocket frames: browser DevTools > Network > WS
