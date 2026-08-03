# Architecture

Skrib is a self-contained collaboration platform with a FastAPI backend and vanilla JavaScript frontend, using SQLite for storage and WebSockets for real-time communication.

## System Overview

```
┌─────────────────────────────────────────────────┐
│                    Client                        │
│  ┌─────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ app.js  │  │ crypto.js│  │ Plugin Scripts │  │
│  │ (UI)    │  │ (E2E)    │  │ (dynamic load) │  │
│  └────┬────┘  └────┬─────┘  └───────┬────────┘  │
│       │            │                │            │
│       └────────────┴────────────────┘            │
│                    │                             │
│          ┌────────────────────┐                  │
│          │  Single WebSocket  │                  │
│          │  + REST API calls  │                  │
│          └────────────────────┘                  │
└───────────────────┬─────────────────────────────┘
                    │
┌───────────────────┴─────────────────────────────┐
│                   Server (port 8000)             │
│  ┌──────────────────────────────────────────┐    │
│  │              FastAPI (ASGI)               │    │
│  │  ┌─────┐ ┌──────┐ ┌───────┐ ┌────────┐  │    │
│  │  │Auth │ │Rooms │ │  WS   │ │Plugin  │  │    │
│  │  │     │ │      │ │Manager│ │Bridge  │  │    │
│  │  └──┬──┘ └──┬───┘ └───┬───┘ └───┬────┘  │    │
│  │     │       │         │         │        │    │
│  │     └───────┴─────────┴─────────┘        │    │
│  │                  │         │              │    │
│  │         ┌────────┴───┐  ┌──┴────────────┐│    │
│  │         │ SQLite(WAL)│  │ Plugin Bus    ││    │
│  │         │ ┌────┐┌───┐│  │ Server (:9000)││    │
│  │         │ │core││plg││  └───┬──┬──┬─────┘│    │
│  │         │ │ .db││.db││      │  │  │      │    │
│  │         │ └────┘└───┘│      │  │  │      │    │
│  │         └────────────┘      │  │  │      │    │
│  └─────────────────────────────┼──┼──┼──────┘    │
└────────────────────────────────┼──┼──┼───────────┘
                            WS   │  │  │
                         ┌───────┘  │  └────────┐
                         │          │           │
                    ┌────┴───┐ ┌────┴───┐ ┌─────┴──┐
                    │ Plugin │ │ Plugin │ │ Plugin │
                    │ (chat) │ │ (todo) │ │ (push) │
                    └────────┘ └────────┘ └────────┘
                    (process)   (process)  (process)
```

## Backend

### Framework

FastAPI running on Uvicorn (ASGI). Single-process, async. All routes are registered in `main.py` with an `/api` prefix.

### Module Convention

Each feature module follows a consistent structure:

```
backend/skrib/{module}/
  routes.py       # FastAPI router with endpoint definitions
  schemas.py      # Pydantic models for request/response validation
  services.py     # Business logic (database queries, processing)
```

Modules: `auth`, `rooms`, `room_folders`, `users`, `server`, `themes`, `ws`, `plugins`, `plugin_bus`, `admin`

### Database

SQLite with WAL (Write-Ahead Logging) mode for concurrent read access. Configured in `database.py`:

- WAL mode enabled on connection
- Foreign keys enforced on every connection
- 30-second busy timeout
- Thread-local connections
- Database path: `data/chat.db`

### Core Tables

| Table | Purpose | Key |
|---|---|---|
| `users` | User accounts, credentials, encryption keys | `username` (PK) |
| `challenges` | WebAuthn challenge storage | `challenge` (PK) |
| `settings` | Server configuration (key-value) | `key` (PK) |
| `rooms` | Room metadata (includes `visibility`) | `room_id` (PK) |
| `room_users` | Room membership, roles, read state | `room_id + username` |
| `join_requests` | Join requests from users to public rooms | `room_id + username` |
| `room_keys` | Encrypted per-user room keys | `room_id + key_epoch + username` |
| `room_folders` | Nestable folder structure | `folder_id` (PK) |
| `invite_tokens` | Registration invite tokens | `token` (PK) |
| `plugin_approvals` | Plugin approval state (pending/approved/rejected/disabled) | `plugin_id` (PK) |
| `plugin_settings` | Typed plugin configuration (server + user scope) | `plugin_id + key + scope + username` |

Each plugin has its own database at `data/plugins/{plugin_id}.db` with plugin-managed schema.

**Known fault in the current split:** `room_users.last_read_message_id`
(`database.py:172`) is a core column pointing at the `messages` table, which lives
in the *chat plugin's* database file
(`plugins/four43.room-type-chat/backend/plugin_bus.py:21`). No foreign key is
possible across database files, unread counting requires a cross-process
round-trip, and message search cannot exist in core because core has no messages.

> **Changing.** `docs/spec/2026-08-02-core-log-and-signal.md` moves message
> storage into a core per-room append-only **item log**, and adds a transient
> **signal** channel for ephemeral room traffic (typing, WebRTC signalling). After
> that, `last_read_message_id` becomes a real foreign key, room types become
> renderers over the log rather than owners of storage, and
> `four43.chat-typing` is deleted.

### Middleware Stack

Applied in order in `main.py`:

1. **GZip compression** — compress all responses
2. **CORS** — configured via `CORS_ORIGINS` (defaults to `["*"]`)
3. **Cache-Control** — `max-age=300` for static and theme assets
4. **PluginAuthMiddleware** — authenticates and injects headers for plugin routes; proxies requests to bus-connected plugins

### Auth Middleware

Defined in `dependencies.py` as FastAPI dependencies:

| Dependency | Usage |
|---|---|
| `require_auth` | Returns authenticated username or 401 |
| `require_admin` | Returns username if admin role or 403 |
| `require_moderator` | Returns username if moderator or admin or 403 |
| `verify_token` | For WebSocket auth (same logic, different error handling) |

### Static File Serving

- Frontend dist served at `/` via FastAPI `StaticFiles` mount
- Plugin frontend files served via `GET /api/plugins/{plugin_id}/file/{path}` with path traversal protection
- Theme CSS served via `GET /api/themes/{theme_id}`

## Frontend

### Build System

Vite with vanilla JavaScript. No framework. ES module imports within core code.

### Page Architecture

Multi-page application (not SPA). Each page is a separate HTML file with its own JS entry point:

| Page | Entry | Purpose |
|---|---|---|
| `login.html` | `login.js` | Passkey login |
| `register.html` | `register.js` | Username registration |
| `enroll-passkey.html` | `enroll-passkey.js` | Passkey enrollment + key generation |
| `key-recovery.html` | `key-recovery.js` | Passphrase-based key recovery |
| `app.html` | `app.js` | Main application |
| `settings.html` | `settings.js` | User settings |
| `admin.html` | `admin.js` | Admin panel |
| `room-settings.html` | `room-settings.js` | Per-room settings |

### State Management

Module-level variables in `app.js` — no state library:

| Variable | Type | Description |
|---|---|---|
| `sessionToken` | String | Current auth token |
| `currentUsername` | String | Logged-in user |
| `currentRole` | String | Global role (admin/moderator/user) |
| `currentRoom` | String | Active room ID |
| `ws` | WebSocket | Active connection |
| `roomMeta` | Map | Room ID -> metadata cache |
| `privateKey` | CryptoKey | RSA private key from IndexedDB |
| `roomKeys` | Map | Room ID -> epoch -> AES-GCM key |
| `folderData` | Object | Folder tree structure |
| `userColors` | Map | Username -> assigned color |
| `userNicknames` | Map | Username -> display name |

Functions are exposed on `window` for inline event handlers and cross-module access.

### Plugin Loading

1. Fetch plugin list from `GET /api/plugins`
2. For each enabled plugin with `frontend_entry`: inject a `<script>` tag pointing to `/api/plugins/{id}/file/{entry}`
3. Initialize via `window['Four43.{plugin-id}Plugin'].init(context)`
4. Plugins are loaded as non-module scripts to maintain isolation from core ES module internals

### Local Storage

| Key | Content |
|---|---|
| `session_token` | Current auth token |
| `username` | Current username |
| `role` | Current global role |
| `skrib_ui_prefs` | UI preferences (collapsed folders, sidebar state) |
| `skrib_servers` | Multi-server list |
| `skrib_theme_css_*` | Cached theme CSS (prevents FOUC) |

## Deployment

### Docker (Production)

Single container via `docker-compose.yml`:

```bash
docker-compose up --build
```

- Uvicorn serves both the API and the built frontend assets
- Volume mounts for `data/` (database persistence)
- Port 8000

### Local Development

Two or three processes:

```bash
# Terminal 1: Backend with auto-reload (also starts the bus server on port
# 9000, and loads any runtime: in_process plugins in-process)
cd backend && uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2: Frontend with HMR
cd frontend && npm run dev  # port 5173, proxies /api to :8000

# Terminal 3 (optional): the runtime: "process" plugins
cd backend && ./util/start-plugins
```

**Basic messaging needs no external process.** Each plugin declares a
`runtime` in its manifest: `in_process` plugins are loaded and hosted inside
the backend by `InProcessHost` (started alongside the app in `main.py`);
`process` plugins — the default when `runtime` is absent — run standalone and
connect to the bus server. `four43.room-type-chat` is `runtime: "in_process"`,
so a server started with no `start-plugins` at all still has working chat.

`start-plugins` remains for the six plugins that still declare or default to
`runtime: "process"` (`attachments`, `chat-typing`, `emoji-picker`,
`message-reactions`, `room-type-todo`, `web-push`). It is still fire-and-forget
bash with PID files: no supervision, no restart on crash, no health check.

> **Changing.** `docs/spec/2026-08-02-extension-model.md` §5 moves plugin
> lifecycle into the app, so core spawns and supervises `runtime: "process"`
> plugins itself and an admin never needs to know that plugins are processes.
> That supervision work is still outstanding — `start-plugins` is what runs
> today, for whichever plugins are left on the bus.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `RP_ID` | `localhost` | WebAuthn Relying Party ID (must match your domain) |
| `SKRIB_REGISTRATION_MODE` | (from DB) | Override registration mode |
| `CORS_ORIGINS` | `["*"]` | Allowed CORS origins (restrict in production) |
| `VITE_API_URL` | `/api` | Frontend API base URL |
| `SKRIB_PLUGIN_BUS_HOST` | `127.0.0.1` | Plugin bus server bind address |
| `SKRIB_PLUGIN_BUS_PORT` | `9000` | Plugin bus server port |
| `SKRIB_BUS_URL` | `ws://127.0.0.1:9000` | Bus URL for plugin processes |

### Database Reset

In early development, there are no migrations. To reset:

```bash
rm -rf data/*
```

Restart the server. A fresh database is created automatically.

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/main.py` | App entry, router registration, middleware, bus startup |
| `backend/skrib/database.py` | SQLite connection, WAL mode, schema creation |
| `backend/skrib/config.py` | Configuration constants |
| `backend/skrib/dependencies.py` | Auth middleware (require_auth, require_admin) |
| `backend/skrib/permissions.py` | Centralized permission checking |
| `backend/skrib/plugin_bus/server.py` | Out-of-process plugin bus server (port 9000) |
| `backend/skrib/plugin_bus/bridge.py` | Translates bus frames to/from WS manager; resolves in-process vs. bus-connected per room type |
| `backend/skrib/plugin_bus/inprocess_host.py` | Loads and hosts `runtime: in_process` plugins inside the backend |
| `backend/skrib/plugin_bus/approvals.py` | Plugin approval service |
| `backend/skrib/plugin_bus/settings.py` | Plugin settings service |
| `backend/skrib/plugins/registry.py` | Single runtime-agnostic answer to "which plugins are active" (in-process + bus-connected); replaces direct reads of the bus server's connection map |
| `backend/skrib/admin/routes.py` | Admin plugin approval API |
| `backend/skrib_plugin_sdk/` | Python SDK for out-of-process plugins |
| `backend/util/start-plugins` | Dev script to start/stop all plugin processes |
| `frontend/vite.config.js` | Vite build config, API proxy |
| `docker-compose.yml` | Container orchestration |
