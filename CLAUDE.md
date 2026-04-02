# Skrīb

Real-time collaboration app with WebAuthn/Passkey auth. FastAPI backend, vanilla JS frontend, SQLite DB, WebSocket messaging.

## Detailed Documentation

Read these files on demand when working on specific areas:

- **Backend API & structure**: `backend/README.md`
- **Frontend Web App architecture**: `frontend/README.md`
  - **WebAuthn testing via Playwright**: `docs/playwright-webauthn-testing.md`
- **Feature planning**: `docs/planning-feature-list.md`
- **E2E encryption design**: `docs/end-to-end-encryption.md`
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
  messages/              # Message search
  admin/                 # User management, settings
  database.py            # SQLite + WAL mode
  dependencies.py        # Auth middleware
  main.py                # App entry & router registration

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
- Two namespaces: `system.*` (connection-level) and `room.*` (all room traffic)
- **User-scoped** events (`room.update`, `room.new_message`) go to all of a user's tabs
- **Room-scoped** events (`room.message`, `room.topic`) go only to tabs that sent `room.join`
- Client sends `room.join`/`room.leave` when switching rooms (no WS teardown)
- Messages sent via `room.message` (from client) or HTTP `POST /rooms/{room_id}/messages`
- Implementation in `backend/skrib/ws/` (manager.py, handlers.py, routes.py)

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
- `install-plugins` — runs `npm install` in each plugin frontend
- `build` — builds all plugins, then the main frontend
- `dev` — builds plugins once, starts `npm run watch` in each (background), then runs `vite` dev server

These are wired into the main frontend `package.json` scripts (`npm run dev`, `npm run build`).

## Running

```bash
# Backend
cd backend && pip install -e . && uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (installs plugin deps, builds plugins, starts dev server)
cd frontend && npm install && ./util/install-plugins && npm run dev  # port 5173

# Docker
docker-compose up --build
```

## Testing

You MUST USE ./util/test-e2e for E2E tests, it sets SKRIB_TEST_DATA_DIR and builds the frontend. Each test gets an isolated backend + temp SQLite DB, so they are fully parallel-safe. WebAuthn is handled via CDP virtual authenticators (Chromium only). Don't run `npx playwright test` directly., it won't set up the environment correctly.

```bash
# E2E tests (builds frontend, spawns isolated backends per test)
cd frontend && ./util/test-e2e                              # run all e2e tests
cd frontend && ./util/test-e2e tests/e2e/core.spec.js       # run a specific test file
cd frontend && ./util/test-e2e --grep "room members"        # filter by test name

# DOM/unit tests
cd frontend && ./util/test
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
