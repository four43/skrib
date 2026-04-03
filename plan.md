# Plan: Out-of-Process Plugin Bus — Full Implementation

## Context

Skrib's plugin system currently runs all 7 plugins in-process with the FastAPI backend. Plugins extend a Python base class, receive direct references to the WebSocket manager and CoreAPI, and are loaded via Python import at startup. This proposal replaces the entire in-process system with an out-of-process architecture where each plugin runs as a separate process communicating over a dedicated WebSocket bus.

**No hybrid mode** — there will be a cutover point where the old in-process loading is removed entirely. Phases 1-2 build infrastructure alongside the existing system. Phase 3 is the atomic cutover.

Design decisions are documented in `docs/plugin-system.md` under "Proposed: Out-of-Process Plugin Bus".

---

## Phase 1: Plugin Bus Server + Python SDK

**Goal**: Build and test the bus server and SDK as standalone components. No changes to core dispatch yet — the existing in-process system continues to work.

### 1a: Bus Server

New module `backend/skrib/plugin_bus/` (separate from `backend/skrib/plugins/`):

| File | Purpose |
|---|---|
| `backend/skrib/plugin_bus/__init__.py` | Package init |
| `backend/skrib/plugin_bus/server.py` | WebSocket server on port 9000, accepts plugin connections |
| `backend/skrib/plugin_bus/protocol.py` | Frame types, serialization, validation |
| `backend/skrib/plugin_bus/permissions.py` | Permission enforcement per-frame |
| `backend/skrib/plugin_bus/rate_limit.py` | Token bucket rate limiter per connection |
| `backend/skrib/plugin_bus/registry.py` | Track connected plugins, room type registrations, published events |

**Server responsibilities:**

- Accept WebSocket connections from plugin processes
- Handle `hello` handshake (validate secret, check approval status)
- Route frames between core and plugins based on namespace
- Enforce permissions on every outgoing frame
- Rate limit per-plugin (100 msg/s, burst 200)
- Track which plugins have registered for which room types
- Validate inter-plugin subscriptions against published_events
- Handle plugin disconnect/reconnect gracefully

**Protocol frames** (defined in `protocol.py`):

- Enumerate all frame types from the doc: hello, hello_ack, bus.broadcast_room, bus.notify_user, bus.reply, room.action, lifecycle.*, callback.request, callback.response, core_api.request, core_api.response, register.room_type, register.frontend, register.settings, register.callback, event, config.updated, error
- Each frame has `type`, `request_id` (for correlation), and type-specific fields
- Validation: reject malformed frames, unknown types, missing required fields

### 1b: Python SDK

New package `backend/skrib_plugin_sdk/` (or `skrib-plugin-sdk/` at repo root):

| File | Purpose |
|---|---|
| `skrib_plugin_sdk/__init__.py` | Public API exports |
| `skrib_plugin_sdk/client.py` | WebSocket client, connection management, reconnection |
| `skrib_plugin_sdk/plugin.py` | SkribPlugin base class (decorator-based handler registration) |
| `skrib_plugin_sdk/bus.py` | PluginBus methods (broadcast_to_room, notify_user, etc.) |
| `skrib_plugin_sdk/core_api.py` | CoreAPI client (sends core_api.request frames, awaits responses) |
| `skrib_plugin_sdk/http.py` | Helper to run plugin's HTTP server (FastAPI/Starlette) |
| `skrib_plugin_sdk/types.py` | Typed dataclasses for all frame types |

**SDK plugin authoring pattern:**

```python
from skrib_plugin_sdk import SkribPlugin, on_room_action, on_lifecycle, callback

class ChatTypingPlugin(SkribPlugin):
    id = "four43.chat-typing"
    version = "1.0.0"
    permissions = ["bus.send", "bus.receive"]
    published_events = ["typing_start", "typing_stop"]

    @on_room_action("typing")
    async def handle_typing(self, ctx):
        await ctx.bus.broadcast_to_room(ctx.room_id, "typing_start",
                                         username=ctx.username,
                                         exclude_user=ctx.username)

    @on_lifecycle("room_deleted")
    async def handle_room_deleted(self, ctx):
        self.typing_state.pop(ctx.room_id, None)
```

**Client responsibilities:**

- Connect to bus server, send hello with manifest
- Handle hello_ack (approved / pending / rejected)
- Reconnect with exponential backoff on disconnect
- Dispatch incoming frames to registered handlers
- Correlate request/response pairs (core_api calls, callbacks)
- Expose async PluginBus methods that send frames and optionally await responses

### 1c: Testing

- **Bus server unit tests**: Connection handshake, permission enforcement, rate limiting, namespace routing, plugin disconnect handling
- **SDK unit tests**: Reconnection logic, frame serialization, handler dispatch
- **Integration test**: Spin up bus server, connect a mock plugin via SDK, verify round-trip frame delivery
- Test file: `backend/tests/test_plugin_bus.py` (or `tests/` in SDK package)

### Files modified

- `backend/skrib/main.py` — Start bus server alongside the app (but not yet dispatching to it)

---

## Phase 2: Core-Side Bus Integration + CoreAPI HTTP Endpoints

**Goal**: Build core's side of the bus bridge — the code that will dispatch room actions over the bus, relay plugin broadcasts to the client WebSocket manager, and expose CoreAPI as HTTP endpoints. Still not wired in — old system runs. This phase builds the replacement dispatch layer and tests it end-to-end with a test plugin.

### 2a: Core Bus Client

New file `backend/skrib/plugin_bus/bridge.py`:

- Core connects to the bus server as a special "core" client
- Receives plugin→core frames (bus.broadcast_room, bus.notify_user, core_api.request, register.*)
- For `bus.broadcast_room`: calls `UnifiedConnectionManager.broadcast_to_room()`
- For `bus.notify_user`: calls `UnifiedConnectionManager.notify_user()`
- For `core_api.request`: calls CoreAPI methods, sends `core_api.response` back
- For `register.room_type`: updates room type → plugin mapping
- For `register.frontend`: records frontend assets for plugin file serving

Sends core→plugin frames:

- `room.action`: when a client sends a room-namespaced message for a bus-connected plugin's room type
- `lifecycle.*`: room created/deleted, user joined/left
- `callback.request`: unread counts, message interception
- `event`: cross-plugin events the plugin subscribed to

### 2b: CoreAPI HTTP Endpoints

Add endpoints to `backend/skrib/plugins/routes.py` (or a new `backend/skrib/plugins/core_api_routes.py`):

| Endpoint | Purpose | Replaces |
|---|---|---|
| `GET /api/core/rooms/{room_id}/members` | List room members | `core_api.get_room_members()` |
| `GET /api/core/rooms/{room_id}` | Room info with member details | `core_api.get_room_info()` |
| `GET /api/core/rooms/{room_id}/members/{username}` | Member details + notify level | `core_api.get_notify_level()` |
| `POST /api/core/rooms/{room_id}/read` | Mark room read | `core_api.mark_room_read()` |
| `GET /api/core/users/{username}/presence` | Check if user connected | `core_api.is_user_connected()` |

These endpoints use internal plugin auth (plugin secret or trusted header from bus). Available to both bus-connected plugins (calling via HTTP) and core_api.request frames (bridge translates).

### 2c: HTTP Proxy for Plugin Routes

Modify `backend/skrib/plugins/middleware.py`:

- For bus-connected plugins, proxy HTTP requests to the plugin's `http_base_url`
- Inject same auth headers (`x-skrib-username`, `x-skrib-user-role`, `x-skrib-room-role`)
- Plugin's HTTP base URL is registered during hello handshake

### 2d: Testing

- **Bridge integration tests**: Bus server + bridge + mock plugin. Verify:
  - Plugin sends `bus.broadcast_room` → bridge calls UnifiedConnectionManager → client receives
  - Client sends room action → bridge sends `room.action` → plugin receives
  - Plugin sends `core_api.request` → bridge calls CoreAPI → plugin gets response
- **CoreAPI HTTP tests**: Verify each endpoint returns correct data
- **HTTP proxy tests**: Request proxied to plugin process, auth headers injected

### Files created/modified

- `backend/skrib/plugin_bus/bridge.py` — Core-side bus client (new)
- `backend/skrib/plugins/core_api_routes.py` — CoreAPI HTTP endpoints (new)
- `backend/skrib/plugins/middleware.py` — Add HTTP proxy capability
- `backend/skrib/plugins/routes.py` — Plugin file serving from bus-registered assets

---

## Phase 3: Cutover — Migrate All Plugins, Remove Old System

**Goal**: Convert all 7 plugins to use the SDK, replace core dispatch with bus, remove old in-process loading. This is the atomic switchover.

### 3a: Convert Plugins (simplest → most complex)

**Migration order** based on coupling complexity:

1. **four43.chat-typing** — No storage, no HTTP routes. Pure bus pub/sub. Simplest possible plugin.
2. **four43.emoji-picker** — HTTP routes only, no WebSocket handler, no storage.
3. **four43.message-reactions** — HTTP routes + WS handler + storage. Tests cross-cutting feature plugin.
4. **four43.attachments** — HTTP routes + storage + file handling.
5. **four43.web-push** — HTTP routes + storage + CoreAPI calls (presence check, room members).
6. **four43.room-type-todo** — Room type plugin with full CRUD. Tests room type registration.
7. **four43.room-type-chat** — Most complex. Room type + CoreAPI + callbacks (unread counts). Tests everything.

**Per-plugin migration:**

- Create standalone entry point (`main.py` or `__main__.py`) that instantiates plugin and connects to bus
- Replace `Plugin` base class with SDK's `SkribPlugin`
- Replace `PluginBus` calls with SDK bus methods
- Replace `core_api.*` calls with SDK CoreAPI client (HTTP or bus frame)
- Replace `self.get_plugin_db()` with direct SQLite access (plugin manages own DB)
- Replace FastAPI router with standalone HTTP server (SDK helper)
- Update `manifest.json` with `published_events` and `subscriptions`
- Plugin runs as: `python -m backend.plugins.four43_chat_typing` (or similar)

### 3b: Core Dispatch Swap

- `backend/skrib/ws/handlers.py` — Room action dispatch goes through bridge instead of `plugin.handle_room_action()`
- `backend/skrib/main.py` — Startup launches bus server, connects bridge. No longer imports/loads plugin Python code.
- `backend/skrib/plugins/registry.py` — Gutted. Now tracks bus-connected plugins (from bridge's registry), not in-process Python objects.

### 3c: Remove Old System

Delete or gut:

- `backend/skrib/plugins/base.py` — Old Plugin/PluginBus classes (SDK replaces this)
- `backend/skrib/plugins/callbacks.py` — Replaced by bus callback.request/response
- `backend/skrib/plugins/core_api.py` — Replaced by HTTP endpoints + bus frames
- Old plugin discovery code in `registry.py`

### 3d: Frontend Changes

- `frontend/src/app.js` plugin loading — Now gets frontend assets from bus-registered entries instead of filesystem manifest scan
- Plugin file serving in `routes.py` — For bus-connected plugins, fetch from plugin's HTTP server or use cached assets from registration

### 3e: Plugin Process Management

For development: each plugin started as a separate process. Options:

- **Dev script** (`frontend/util/dev` or `backend/util/dev`): starts all plugin processes alongside core
- **Docker Compose**: each plugin is a service
- **Procfile-style**: `foreman` or `honcho` starts all processes

### 3f: Testing

- **E2E tests**: Full stack — core + bus + all plugins as separate processes. Use `./util/test-e2e`.
- **Per-plugin tests**: Each plugin has its own test suite that connects to a test bus server.
- **Verify**: All existing E2E tests pass with the new architecture.

### Files created/modified

- Every plugin directory (7 plugins) — new entry point, SDK usage
- `backend/skrib/ws/handlers.py` — Bus dispatch
- `backend/skrib/main.py` — Bus server startup, no plugin loading
- `backend/skrib/plugins/registry.py` — Rewrite for bus-connected plugins
- `backend/skrib/plugins/base.py` — Remove (or keep as thin compat)
- `backend/skrib/plugins/callbacks.py` — Remove
- `backend/skrib/plugins/core_api.py` — Remove (replaced by HTTP routes)
- `frontend/src/app.js` — Plugin loading from bus-registered assets

---

## Phase 4: Plugin Approval System

**Goal**: Admin must approve new plugins before they activate. Manifest changes re-trigger approval.

### 4a: Database

New table `plugin_approvals`:

```sql
CREATE TABLE plugin_approvals (
    plugin_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, disabled
    manifest_hash TEXT NOT NULL,             -- SHA256 of manifest JSON
    manifest_json TEXT NOT NULL,             -- Full manifest for admin review
    approved_by TEXT,                        -- Admin username
    approved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 4b: Bus Server Changes

- On `hello`: compute manifest hash, check `plugin_approvals` table
- If approved with same hash → `hello_ack` status: approved
- If approved but hash changed → re-enter pending, notify admin
- If pending → `hello_ack` status: pending_approval, hold connection open
- If rejected → `hello_ack` status: rejected, close connection
- When admin approves a pending plugin, send `hello_ack` approved over the held connection

### 4c: Admin API

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/plugins/pending` | List plugins awaiting approval |
| `GET /api/admin/plugins/approved` | List approved plugins |
| `POST /api/admin/plugins/{plugin_id}/approve` | Approve plugin |
| `POST /api/admin/plugins/{plugin_id}/reject` | Reject plugin |
| `POST /api/admin/plugins/{plugin_id}/disable` | Disable approved plugin |
| `GET /api/admin/plugins/{plugin_id}/manifest-diff` | Show what changed if re-approval needed |

### 4d: Admin UI

Page in admin section showing:

- Pending plugins with manifest details (permissions requested, room types, published events)
- Approve/reject buttons
- List of approved plugins with disable option
- Manifest diff view when a plugin requests new permissions

### 4e: Testing

- Test: new plugin connects → pending state → admin approves → plugin activates
- Test: approved plugin changes manifest → re-enters pending
- Test: admin rejects → plugin disconnected
- Test: admin disables → plugin disconnected, won't auto-reconnect

### Files created/modified

- `backend/skrib/plugin_bus/server.py` — Approval check in hello handler
- `backend/skrib/plugin_bus/registry.py` — Approval state tracking
- `backend/skrib/admin/routes.py` — New approval endpoints (or new file)
- `frontend/src/admin.js` or new admin page — Approval UI

---

## Phase 5: Plugin Settings System

**Goal**: Plugins declare typed settings that admins (server scope) and users (user scope) can configure.

### 5a: Database

New table `plugin_settings`:

```sql
CREATE TABLE plugin_settings (
    plugin_id TEXT NOT NULL,
    key TEXT NOT NULL,
    scope TEXT NOT NULL,          -- 'server' or 'user'
    username TEXT,                -- NULL for server scope, username for user scope
    value TEXT NOT NULL,          -- JSON-encoded value
    PRIMARY KEY (plugin_id, key, scope, COALESCE(username, ''))
);
```

### 5b: Settings Registration

When plugin sends `register.settings` frame:

- Bus stores the schema (key, label, type, default, scope, description)
- Core serves schema via API for admin/user UI
- Default values used until explicitly configured

### 5c: Settings API

| Endpoint | Purpose |
|---|---|
| `GET /api/plugins/{plugin_id}/settings/schema` | Get settings schema |
| `GET /api/plugins/{plugin_id}/settings` | Get current server settings (admin) |
| `PATCH /api/plugins/{plugin_id}/settings` | Update server settings (admin) |
| `GET /api/plugins/{plugin_id}/settings/user` | Get current user settings |
| `PATCH /api/plugins/{plugin_id}/settings/user` | Update user settings |

When a setting changes, core sends `config.updated` frame to the plugin.

### 5d: UI

- Admin settings page: grouped by plugin, renders controls based on schema type (number, boolean, string, select)
- User preferences page: shows user-scoped plugin settings

### 5e: Testing

- Test: plugin registers settings → schema available via API
- Test: admin updates setting → plugin receives config.updated
- Test: user updates setting → stored per-user, plugin can query

### Files created/modified

- `backend/skrib/plugin_bus/server.py` — Handle register.settings frames
- `backend/skrib/plugins/routes.py` — Settings API endpoints
- `frontend/src/admin.js` — Admin settings UI
- `frontend/src/settings.js` or similar — User settings UI

---

## Verification

After each phase, verify with:

- **Phase 1**: `pytest backend/tests/test_plugin_bus.py` — Bus server + SDK unit/integration tests
- **Phase 2**: `pytest backend/tests/test_plugin_bridge.py` — Bridge + CoreAPI HTTP tests
- **Phase 3**: `cd frontend && ./util/test-e2e` — All existing E2E tests pass with new architecture
- **Phase 4**: `cd frontend && ./util/test-e2e --grep "plugin approval"` — Approval flow tests
- **Phase 5**: `cd frontend && ./util/test-e2e --grep "plugin settings"` — Settings tests

## Key Risk

Phase 3 is the biggest risk — it's the atomic cutover of all 7 plugins plus core dispatch in one shot. Mitigate by:

1. Converting plugins one at a time during development, testing each against the bus server
2. Running existing E2E tests against each converted plugin before proceeding to the next
3. Only removing the old system after all E2E tests pass with the new architecture
