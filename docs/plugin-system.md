# Plugin System

Skrib's functionality is defined by plugins. Room types (chat, todo) and cross-cutting features (typing indicators, reactions, push notifications) are all plugins with isolated storage, manifest-declared permissions, and lifecycle hooks.

## Plugin Types

### Room Type Plugins

Register a room type (e.g., `chat`, `todo`) and handle all WebSocket actions for rooms of that type. When a user sends a `room:*` action, the WebSocket handler looks up the room's type and delegates to the registered plugin's `handle_room_action()` method.

**Bundled room type plugins:**

| Plugin ID | Room Type | Description |
|---|---|---|
| `four43.room-type-chat` | `chat` | Encrypted messaging with history, edit/delete, read receipts |
| `four43.room-type-todo` | `todo` | Collaborative task lists with filtering and real-time sync |

### Feature Plugins

Register their own WebSocket namespace and handle cross-cutting concerns. They observe events from other plugins or core via the event bus.

**Bundled feature plugins:**

| Plugin ID | Namespace | Description |
|---|---|---|
| `four43.chat-typing` | `four43.chat-typing` | Typing indicators (ephemeral, no storage) |
| `four43.message-reactions` | `four43.message-reactions` | Emoji reactions on messages |
| `four43.web-push` | `four43.web-push` | Web Push notifications for offline users |

## Plugin Structure

Each plugin lives in `backend/plugins/{plugin-id}/` with this layout:

```
backend/plugins/four43.room-type-chat/
  manifest.json          # Plugin metadata and permissions
  __main__.py            # Standalone entry point (out-of-process)
  backend/
    plugin.py            # Legacy in-process plugin class
    plugin_bus.py         # SDK-based plugin class (out-of-process)
    services.py          # Business logic (optional)
    routes.py            # HTTP endpoints (optional)
  frontend/
    plugin.js            # Frontend entry point
```

## Manifest

The `manifest.json` declares plugin identity, permissions, and entry points:

```json
{
  "id": "four43.room-type-chat",
  "name": "Chat",
  "version": "1.0.0",
  "description": "Real-time encrypted chat rooms",
  "type": "room-type",
  "room_type": "chat",
  "permissions": [
    "bus.send",
    "bus.receive",
    "http.routes",
    "storage.read",
    "storage.write",
    "core_api",
    "dom.messages"
  ],
  "frontend_entry": "frontend/plugin.js"
}
```

### Permission Model

| Permission | Description |
|---|---|
| `bus.send` | Send messages via the PluginBus (WebSocket broadcast) |
| `bus.receive` | Receive messages from the PluginBus |
| `http.routes` | Register HTTP endpoints under `/api/plugins/{plugin_id}/` |
| `storage.read` | Read from the plugin's isolated SQLite database |
| `storage.write` | Write to the plugin's isolated SQLite database |
| `core_api` | Access core data (users, rooms, memberships) via CoreAPI |
| `dom.messages` | Frontend: manipulate the message display area |
| `dom.input` | Frontend: manipulate the message input area |

Permissions are enforced at runtime. The `PluginBus` auto-prepends the plugin's namespace to outgoing events and rejects operations not declared in the manifest.

## Backend Architecture

Skrib supports two plugin execution modes:

1. **In-process** (legacy) — plugins loaded at startup into the FastAPI process via `backend/skrib/plugins/registry.py`
2. **Out-of-process** (current) — plugins run as separate processes communicating over a WebSocket bus on port 9000

The `ws/handlers.py` dispatcher tries bus-connected plugins first, then falls back to in-process.

### Out-of-Process Plugin SDK

Plugins extend `SkribPlugin` from `backend/skrib_plugin_sdk/`:

```python
from skrib_plugin_sdk import SkribPlugin, on_room_action, on_lifecycle, callback

class MyPlugin(SkribPlugin):
    id = "myorg.my-plugin"
    version = "1.0.0"
    permissions = ["bus.send", "bus.receive"]
    room_types = ["chat"]          # for room type plugins
    table_schema = "CREATE TABLE IF NOT EXISTS ..."  # auto-created on startup
    http_port = 0                   # auto-assign HTTP port for routes

    @on_room_action("message")
    async def handle_message(self, ctx):
        await ctx.bus.broadcast_to_room(ctx.room_id, "message", data=...)

    @on_lifecycle("room_deleted")
    async def handle_delete(self, ctx):
        # cleanup

    @callback("/unread-count")
    async def get_unread(self, ctx):
        return {"result": 42}
```

Each plugin has:
- `backend/plugin_bus.py` — SDK-based plugin class
- `__main__.py` — standalone entry point

Run with: `python plugins/four43.chat-typing/__main__.py` (or use `backend/util/start-plugins`)

### Plugin Bus Server

The bus server (`backend/skrib/plugin_bus/server.py`) runs on port 9000 alongside the main app:

- Accepts WebSocket connections from plugin processes
- Handles `hello` handshake (validates credentials, checks approval status)
- Enforces permissions on every frame
- Rate limits per-plugin (token bucket: 100 msg/s, burst 200)
- Routes frames between core and plugins

### Bridge

The bridge (`backend/skrib/plugin_bus/bridge.py`) connects the bus server to core:

- **Plugin → Client**: translates `bus.broadcast_room`, `bus.notify_user`, `bus.reply` into UnifiedConnectionManager calls
- **Plugin → Core**: handles `core_api.request` frames by calling CoreAPI methods
- **Core → Plugin**: dispatches `room.action`, lifecycle events, callback requests
- **Callbacks**: sends `callback.request` to plugins and correlates responses with timeouts

### CoreAPI

Available both in-process (`backend/skrib/plugins/core_api.py`) and over the bus/HTTP:

| Method | Description |
|---|---|
| `get_room_members(room_id)` | List usernames in a room |
| `get_room_info(room_id)` | Full room details with members |
| `get_notify_level(room_id, username)` | User's notification level |
| `get_unread_count(room_id, username)` | Unread message count |
| `mark_room_read(room_id, username, message_id)` | Update read position |
| `is_user_connected(username)` | Check active WebSocket connections |

HTTP endpoints at `GET/POST /api/core/rooms/*` and `GET /api/core/users/*/presence`.

### Plugin Approval System

New plugins require admin approval before activating (`backend/skrib/plugin_bus/approvals.py`):

1. Plugin connects and sends `hello` with its manifest
2. Manifest is hashed (SHA-256) and compared against stored approval
3. New plugins enter `pending` state; admin reviews permissions and approves/rejects
4. Previously approved plugins reconnect automatically if manifest hasn't changed
5. Manifest changes re-trigger approval

Admin API at `GET/POST /api/admin/plugins/*` (approve, reject, disable, manifest-diff).

### Plugin Settings System

Plugins declare typed settings schemas via `register.settings` frames (`backend/skrib/plugin_bus/settings.py`):

- **Server-scoped**: configured by admins, applies to all users
- **User-scoped**: configured by each user in preferences
- Settings API at `GET/PATCH /api/plugins/{id}/settings` (admin) and `/settings/user` (user)
- `config.updated` frames sent to plugins when settings change

### Isolated Storage

Each plugin gets its own SQLite database at `data/plugins/{plugin_id}.db`. Plugins manage their own schema. Core tables are never shared.

### PluginAuthMiddleware

An ASGI middleware (`middleware.py`) that authenticates requests to plugin routes:

1. Strips any client-supplied `x-skrib-*` headers (anti-spoofing)
2. Extracts the `Authorization: Bearer` token
3. Validates the session and injects trusted headers: `x-skrib-username`, `x-skrib-user-role`, `x-skrib-room-role`
4. For bus-connected plugins with `http_base_url`, proxies HTTP requests to the plugin's process
5. Maintains a 30-second auth cache per token

## Frontend Architecture

### Plugin Loading

Plugins are loaded dynamically in `app.js`:

1. `GET /api/plugins` returns the list of enabled plugins with manifests
2. For each plugin with a `frontend_entry`, a `<script>` tag is injected pointing to `/api/plugins/{id}/file/{entry}`
3. After loading, the plugin is initialized by calling `window['Four43.{plugin-id}Plugin'].init(context)`

### Plugin Context

Each plugin receives a context object with:

| Property | Type | Description |
|---|---|---|
| `sendWs(type, data)` | Function | Send a WebSocket message |
| `currentRoom()` | Getter | Current room ID |
| `sessionToken()` | Getter | Current session token |
| `roomKeys()` | Getter | Current room's decrypted key epochs |
| `encryptMessage(text)` | Function | Encrypt text with the current room key |
| `decryptMessage(envelope)` | Function | Decrypt an encrypted message envelope |
| `registerHandler(type, fn)` | Function | Register a WebSocket message handler |
| `registerRoomTypeHandler(fn)` | Function | Register as the room type handler |
| `loadRooms()` | Function | Trigger sidebar room list refresh |
| `escapeHtml(str)` | Function | HTML-escape a string |
| `getDisplayName(username)` | Function | Get a user's display name (nickname or username) |
| `userColors` | Object | Map of username to assigned color |
| `roomMeta()` | Getter | Current room metadata |
| `API_URL` | String | Base API URL |

### Plugin Isolation

- Plugins are loaded as non-module `<script>` tags (not ES modules) to prevent import-based access to core internals
- State is accessed through getter functions rather than direct variable references
- The context object is the only bridge between core and plugin code

## Plugin Management

- `GET /api/plugins` — list all plugins with manifests, includes both in-process and bus-connected (authenticated)
- `PATCH /api/plugins/{plugin_id}` — enable or disable a plugin (admin only)
- `GET /api/admin/plugins/pending` — list plugins awaiting approval (admin)
- `GET /api/admin/plugins/approved` — list approved plugins (admin)
- `POST /api/admin/plugins/{plugin_id}/approve` — approve a plugin (admin)
- `POST /api/admin/plugins/{plugin_id}/reject` — reject a plugin (admin)
- `POST /api/admin/plugins/{plugin_id}/disable` — disable an approved plugin (admin)
- `GET /api/admin/plugins/{plugin_id}/manifest-diff` — review manifest for approval (admin)
- `GET /api/plugins/{plugin_id}/settings/schema` — get settings schema (authenticated)
- `GET/PATCH /api/plugins/{plugin_id}/settings` — server settings (admin)
- `GET/PATCH /api/plugins/{plugin_id}/settings/user` — user settings (authenticated)
- `GET /api/core/rooms/{room_id}/members` — room members (plugin use)
- `GET /api/core/rooms/{room_id}` — room info (plugin use)
- `GET /api/core/users/{username}/presence` — user connection status (plugin use)

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/plugin_bus/server.py` | WebSocket bus server (port 9000) |
| `backend/skrib/plugin_bus/bridge.py` | Core-side bus client (translates frames ↔ WS manager) |
| `backend/skrib/plugin_bus/protocol.py` | Frame types, validation, permissions |
| `backend/skrib/plugin_bus/approvals.py` | Plugin approval service (DB operations) |
| `backend/skrib/plugin_bus/settings.py` | Plugin settings service |
| `backend/skrib/plugin_bus/rate_limit.py` | Token bucket rate limiter |
| `backend/skrib_plugin_sdk/plugin.py` | SkribPlugin base class (SDK) |
| `backend/skrib_plugin_sdk/client.py` | WebSocket bus client |
| `backend/skrib_plugin_sdk/bus.py` | PluginBus (broadcast, notify, reply, emit) |
| `backend/skrib_plugin_sdk/core_api.py` | CoreAPI client over bus frames |
| `backend/skrib_plugin_sdk/database.py` | Plugin database helpers |
| `backend/skrib_plugin_sdk/loader.py` | Plugin package loader |
| `backend/skrib/plugins/base.py` | Legacy in-process SkribPlugin ABC, PluginBus |
| `backend/skrib/plugins/registry.py` | In-process plugin discovery and loading |
| `backend/skrib/plugins/core_api.py` | In-process CoreAPI |
| `backend/skrib/plugins/core_api_routes.py` | CoreAPI HTTP endpoints |
| `backend/skrib/plugins/callbacks.py` | In-process callback dispatcher |
| `backend/skrib/plugins/middleware.py` | PluginAuthMiddleware + HTTP proxy |
| `backend/skrib/plugins/routes.py` | Plugin management REST API |
| `backend/skrib/plugins/settings_routes.py` | Plugin settings REST API |
| `backend/skrib/plugins/auth.py` | Plugin auth helpers |
| `backend/skrib/admin/routes.py` | Admin plugin approval API |
| `frontend/src/app.js` (lines 53-285) | Frontend plugin loader and context |

## Writing a New Plugin

1. Create a directory under `backend/plugins/` with a namespaced ID (e.g., `myorg.my-feature`)
2. Write a `manifest.json` declaring permissions and entry points
3. Create `backend/plugin_bus.py` extending `SkribPlugin` from the SDK, using decorators for handlers
4. Create `__main__.py` entry point using the SDK loader
5. Optionally add HTTP routes via `register_routes()` and set `http_port = 0`
6. Optionally add a `frontend/plugin.js` that exports an `init(context)` function on `window`
7. Start the plugin process — it connects to the bus on port 9000 and enters pending approval
8. Admin approves via `POST /api/admin/plugins/{id}/approve`

## Out-of-Process Plugin Bus

Plugins run as **separate processes** communicating over a **WebSocket-based plugin bus** on port 9000. Plugins can run as local subprocesses, Docker containers, or on entirely separate machines.

### Architecture Overview

```
                        Port 8000 (HTTP/WS)         Port 9000 (Plugin Bus WS)
                        ┌────────────────────┐       ┌───────────────────────┐
  Clients ─────────────►│    Skrib Core      │       │   Plugin Bus Server   │
  (browsers)            │                    │◄─────►│   (WebSocket)         │
                        │  - Auth            │       │                       │
                        │  - Rooms           │       │  - Auth/approval      │
                        │  - WS manager      │       │  - Namespace routing  │
                        │  - HTTP proxy      │       │  - Permission enforce │
                        └───────┬────────────┘       └───┬───────┬──────┬───┘
                                │                        │       │      │
                                │                   WS   │  WS   │ WS   │
                                │                        │       │      │
                                │                   ┌────┴──┐ ┌──┴───┐ ┌┴──────┐
                                │                   │Plugin │ │Plugin│ │Plugin │
                                │                   │ Chat  │ │ Todo │ │ Push  │
                                │                   └───────┘ └──────┘ └───────┘
                                │                   (process)  (docker) (remote)
                                │
                         Plugin HTTP proxy
                         (core proxies /api/plugins/{id}/*
                          to plugin's HTTP server)
```

### Plugin Bus Protocol (WebSocket)

Plugins connect to the bus server on a dedicated port (e.g., `ws://localhost:9000/bus`). All communication uses JSON frames.

#### Connection & Authentication

On connect, the plugin sends a `hello` frame identifying itself and presenting credentials:

```json
{
  "type": "hello",
  "plugin_id": "four43.room-type-chat",
  "version": "1.0.0",
  "secret": "<plugin_secret>",
  "manifest": { ... }
}
```

The server validates the secret, checks approval status, and responds:

```json
{
  "type": "hello_ack",
  "status": "approved",
  "config": { "max_message_size": 65536 }
}
```

Or, if the plugin hasn't been approved yet:

```json
{
  "type": "hello_ack",
  "status": "pending_approval",
  "message": "Awaiting admin approval. Plugin will activate once approved."
}
```

#### Message Types

**Plugin → Core (outbound):**

| Type | Purpose | Required Permission |
|---|---|---|
| `bus.broadcast_room` | Broadcast to all clients in a room | `bus.send` |
| `bus.notify_user` | Send to all of a user's sockets | `bus.send` |
| `bus.notify_all` | Send to every connected user | `bus.send` |
| `bus.reply` | Reply to a specific client via reply token | `bus.send` |
| `bus.emit_event` | Emit internal event (cross-plugin, not to clients) | `bus.send` |
| `register.room_type` | Register as handler for a room type | `room_type.register` |
| `register.frontend` | Register frontend script/styles for loading | `frontend.register` |
| `register.settings` | Declare configurable settings schema | `settings.register` |
| `register.callback` | Register a callback endpoint (unread count, etc.) | `callbacks.register` |
| `core_api.request` | Query core data (rooms, users, memberships) | `core_api` |

**Core → Plugin (inbound):**

| Type | Purpose |
|---|---|
| `room.action` | A room action dispatched to this room-type plugin |
| `lifecycle.room_created` | A room of this plugin's type was created |
| `lifecycle.room_deleted` | A room was deleted |
| `lifecycle.user_joined` | A user joined a room |
| `lifecycle.user_left` | A user left a room |
| `callback.request` | Core invoking a plugin callback (unread count, intercept, health) |
| `event` | A bus event this plugin subscribed to |
| `config.updated` | Admin changed a plugin setting |

All outbound messages are auto-namespaced by the bus server (plugin cannot spoof other namespaces). All inbound messages include a `request_id` for correlation where a response is expected.

#### Example: Room Action Flow

```
Client                    Core                    Plugin Bus              Chat Plugin
  │                        │                         │                       │
  │  room.message          │                         │                       │
  │───────────────────────►│                         │                       │
  │                        │  room.action             │                       │
  │                        │  {reply_to, username,    │                       │
  │                        │   room_id, action, data} │                       │
  │                        │────────────────────────►│  room.action           │
  │                        │                         │──────────────────────►│
  │                        │                         │                       │
  │                        │                         │  bus.broadcast_room    │
  │                        │                         │◄──────────────────────│
  │  four43.room-type-     │                         │                       │
  │  chat:message          │◄────────────────────────│                       │
  │◄───────────────────────│                         │                       │
```

### Plugin Approval Flow

On server startup, the plugin bus listens for incoming connections. New (unknown) plugins enter a **pending** state:

1. Plugin connects and sends `hello` with its manifest
2. Bus server records the plugin as `pending_approval` in the database
3. Admin UI shows pending plugins with their declared permissions
4. Admin reviews manifest and either **approves** or **rejects**
5. On approval, the bus sends `hello_ack` with `status: approved` and the plugin activates
6. On rejection, the bus sends `hello_ack` with `status: rejected` and closes the connection

**Approval states:** `pending_approval` → `approved` | `rejected` | `disabled`

Previously approved plugins reconnect automatically (secret + plugin_id match). Admins can revoke approval at any time, which disconnects the plugin immediately.

If a plugin's **manifest changes** (new permissions requested, version bump with capability changes), it re-enters `pending_approval` until the admin reviews the diff.

### Scoped Permissions (Enforced)

The bus server enforces permissions declared in the manifest. Every frame is checked before delivery:

| Permission | Grants |
|---|---|
| `bus.send` | Broadcast to rooms, notify users via the bus |
| `bus.receive` | Receive bus events from other namespaces |
| `room_type.register` | Register as the handler for a room type |
| `http.routes` | Receive proxied HTTP requests from clients |
| `storage.read` | Read from plugin's isolated database |
| `storage.write` | Write to plugin's isolated database |
| `core_api` | Query core data (users, rooms, memberships) |
| `frontend.register` | Register frontend scripts/styles for client loading |
| `settings.register` | Declare admin/user-configurable settings |
| `callbacks.register` | Register callback handlers (unread count, intercept, health) |

Undeclared operations are rejected with an error frame:

```json
{
  "type": "error",
  "code": "permission_denied",
  "message": "Plugin 'four43.chat-typing' lacks 'storage.write' permission",
  "request_id": "abc123"
}
```

### Room Type Registration

Plugins that handle entire room types declare `room_type.register` permission and send a registration frame after `hello_ack`:

```json
{
  "type": "register.room_type",
  "room_type": "chat",
  "display_name": "Chat Room",
  "icon": "message-circle",
  "description": "Real-time encrypted messaging"
}
```

Only one plugin can register for a given room type. Conflicts are rejected. When a client sends a `room.*` action for a room of that type, core routes it to the registered plugin over the bus.

### Frontend Registration

Plugins register their frontend assets over the bus rather than relying on filesystem discovery:

```json
{
  "type": "register.frontend",
  "scripts": ["frontend/dist/plugin.js"],
  "styles": ["frontend/dist/plugin.css"]
}
```

Core serves these files via `GET /api/plugins/{plugin_id}/file/{path}`. For out-of-process plugins, core fetches the file from the plugin's HTTP server on first request and caches it.

### Plugin Settings

Plugins can declare a settings schema that admins (server-level) or users (per-user) can configure:

```json
{
  "type": "register.settings",
  "settings": [
    {
      "key": "max_message_length",
      "label": "Maximum message length",
      "type": "number",
      "default": 4000,
      "scope": "server",
      "description": "Maximum characters per message"
    },
    {
      "key": "show_typing_indicators",
      "label": "Show typing indicators",
      "type": "boolean",
      "default": true,
      "scope": "user",
      "description": "Show when other users are typing"
    }
  ]
}
```

**Setting scopes:**
- `server` — Configured by admins, applies to all users. Stored in core's settings table.
- `user` — Configured by each user in their preferences. Stored per-user.

When settings change, core sends a `config.updated` frame to the plugin. Plugins can also query current settings via `core_api.request`.

### Plugin HTTP Server

Out-of-process plugins run their own HTTP server for:
- Receiving proxied client requests (`/api/plugins/{plugin_id}/*`)
- Serving frontend assets
- Health checks

Core's HTTP proxy adds the same trusted headers as today (`x-skrib-username`, `x-skrib-user-role`, `x-skrib-room-role`) before forwarding.

The plugin declares its HTTP endpoint in the `hello` frame:

```json
{
  "type": "hello",
  "plugin_id": "four43.room-type-chat",
  "secret": "...",
  "manifest": { ... },
  "http_base_url": "http://localhost:8101"
}
```

### Current Status

All components are implemented and tested:

1. **Bus server** — WebSocket server on port 9000, protocol handlers, permission enforcement, rate limiting
2. **Bridge** — Core-side client translating bus frames to/from UnifiedConnectionManager and CoreAPI
3. **SDK** — Python library with `SkribPlugin` base class, decorators, bus client, CoreAPI client, database helpers
4. **Plugin migration** — All 7 bundled plugins have out-of-process versions (`plugin_bus.py` + `__main__.py`)
5. **Approval system** — Admin must approve new plugins; manifest changes re-trigger approval
6. **Settings system** — Typed server/user settings with schema registration and `config.updated` delivery
7. **CoreAPI HTTP** — HTTP endpoints for plugin data access
8. **HTTP proxy** — Middleware proxies requests to bus-connected plugins with auth headers

The in-process plugin system is retained as a fallback — `ws/handlers.py` tries bus-connected plugins first.

### Design Decisions

- **Bus transport**: Plain WebSocket. Skrib already uses WebSockets for the client bus — same infrastructure, no external dependencies. Messages are ephemeral real-time events, not queued work, so broker durability isn't needed. The SDK abstracts the transport, so a broker could be swapped in later without affecting plugin code.

- **Plugin SDK language**: Language-agnostic protocol (JSON frames over WebSocket), with a Python SDK built first. Any language that can open a WebSocket and parse JSON can be a plugin — the Python SDK is a convenience wrapper, not a requirement.

- **Storage**: Plugins manage their own storage. Local/Docker plugins get a data directory path in `hello_ack`. Remote plugins bring their own database entirely. No storage API over the bus — it would add complexity and latency for something plugins handle well themselves.

- **Frontend**: Full script injection into the main page (not iframe sandboxing). The plugin context object is the bridge between core and plugin code. Iframe sandboxing would prevent plugins from manipulating the message display, input area, and other DOM elements they need access to for the features we support.

- **Rate limiting**: Per-plugin token bucket on the bus server (100 messages/second, burst 200). A single global rate per connection — no per-endpoint or per-room granularity needed initially. Throttled plugins are logged so admins can investigate.

- **Plugin-to-plugin communication**: Direct bus events routed by the bus server. Plugins declare subscriptions to other plugin namespaces via `bus.receive`. Plugins **publish their available event scopes** in their manifest so other plugins can discover and subscribe to them:

  ```json
  {
    "id": "four43.room-type-chat",
    "published_events": [
      "message",
      "message_edited",
      "message_deleted"
    ],
    "subscriptions": [
      "core:room_deleted",
      "four43.message-reactions:reaction_added"
    ]
  }
  ```

  The bus server validates subscriptions against published events — a plugin cannot subscribe to events another plugin hasn't explicitly published. All inter-plugin traffic flows through the bus server so permissions and rate limits are enforced.
