# Skrib Plugin System

This is the reference spec for authors building plugins for Skrib. It documents the wire protocol, permissions model, SDK API, and supporting services. A plugin only needs the protocol and the manifest format to integrate — the Python SDK is one of several possible bindings.

> **Authoritative sources.** When this document and the code disagree, the code wins. The canonical reference points are:
>
> - Protocol: [`backend/skrib/plugin_bus/protocol.py`](../backend/skrib/plugin_bus/protocol.py)
> - Bus server: [`backend/skrib/plugin_bus/server.py`](../backend/skrib/plugin_bus/server.py)
> - Bridge to core: [`backend/skrib/plugin_bus/bridge.py`](../backend/skrib/plugin_bus/bridge.py)
> - Python SDK: [`backend/skrib_plugin_sdk/`](../backend/skrib_plugin_sdk)

---

## 1. Overview

Plugins are **separate processes** that connect to Skrib core over a WebSocket *plugin bus* (default `ws://127.0.0.1:9000`). They speak a JSON frame protocol, operate inside a per-plugin permission boundary, and own their own SQLite database. A plugin can be a Python subprocess, a Docker container, or a remote service — anything that can open a WebSocket and parse JSON.

There are two roles a plugin can play:

| Role | Responsibility |
|---|---|
| **Room type plugin** | Owns a room type (e.g. `chat`, `todo`). Receives every `room.*` action sent into rooms of that type and produces messages back to clients. |
| **Feature plugin** | Cross-cutting behaviour with its own namespace (e.g. typing indicators, reactions, push notifications). Listens to events, exposes HTTP routes, or both. |

A plugin can do both — for example, the chat plugin owns the `chat` room type *and* publishes `message`/`message_deleted` events that other plugins subscribe to.

```
                       Port 8000 (HTTP/WS)         Port 9000 (Plugin Bus WS)
                       ┌────────────────────┐       ┌───────────────────────┐
 Clients ─────────────►│    Skrib Core      │       │   Plugin Bus Server   │
 (browsers)            │                    │◄─────►│                       │
                       │  - Auth / Rooms    │       │  - Hello + approval   │
                       │  - WS manager      │       │  - Permission enforce │
                       │  - HTTP proxy      │       │  - Rate limiting      │
                       └───────┬────────────┘       └───┬───────┬──────┬───┘
                               │                       │       │      │
                               │                  WS   │  WS   │ WS   │
                               │                       │       │      │
                               │                  ┌────┴──┐ ┌──┴───┐ ┌┴──────┐
                               │                  │Plugin │ │Plugin│ │Plugin │
                               │                  │ Chat  │ │ Todo │ │ Push  │
                               │                  └───────┘ └──────┘ └───────┘
                               │
                        Plugin HTTP proxy
                        (core proxies /api/plugins/{id}/*
                         to plugin's HTTP server, localhost-only)
```

---

## 1a. Two runtimes, one SDK

Everything above describes a plugin as a separate process on the bus. That's still
true for most plugins, but a manifest may instead declare:

```json
"runtime": "in_process"
```

`runtime` defaults to `"process"` when the key is absent, so every existing
manifest keeps behaving exactly as documented above. An `in_process` plugin is
imported straight into Skrib core's Python interpreter and driven by
`InProcessHost` (`backend/skrib/plugin_bus/inprocess_host.py`) instead of
connecting over the WebSocket bus. Concretely:

- **The SDK is identical either way.** A plugin's `SkribPlugin` subclass in
  `backend/plugin_bus.py` is written the same way regardless of `runtime` — it
  doesn't call the bus client directly, so it can't tell which transport it's
  running over. `InProcessHost` wires it to an `InProcessClient` (an in-memory
  stand-in for the WebSocket client) instead of a real socket.
- **No approval, no permission enforcement, no separate process.** An in-process
  plugin is trusted first-party code: it shares fate with core (a crash can take
  the whole server down) and skips the bus's per-frame permission checks
  entirely. Only ship first-party plugins this way.
- **`ws/handlers.py` doesn't know or care.** It resolves the owning plugin via
  `PluginBusBridge.get_bus_plugin_for_room_type` and dispatches through
  `dispatch_room_action` — both check the in-process registration before falling
  back to the bus, so room-action dispatch is runtime-agnostic.
- **`PluginRegistry` is the only authority on "is this plugin active".**
  (`backend/skrib/plugins/registry.py`, exposed as `app.state.plugin_registry`.)
  It merges `InProcessHost`'s running plugins with the bus server's approved
  connections into one list of records. Code that instead reads the bus server's
  connection map directly (`plugin_bus.plugins`, `plugin_bus.get_plugin(...)`) only
  ever sees `process` plugins and silently drops every in-process one — that
  exact mistake recurred repeatedly while this model was built. Always go through
  the registry.
- Today only `four43.room-type-chat` runs `in_process`; the other six bundled
  plugins run `process`. `backend/util/start-plugins` and
  `backend/util/run-plugins.py` both skip `in_process` plugins when spawning
  subprocesses — see §20.

---

## 2. Plugin layout

A plugin lives under `backend/plugins/{plugin-id}/` with this layout:

```
backend/plugins/myorg.my-plugin/
  manifest.json            # Cosmetic metadata + on-disk fallback
  __main__.py              # Standalone entry point
  backend/
    plugin_bus.py          # SkribPlugin subclass (Python SDK)
    services.py            # Optional business logic
    routes.py              # Optional FastAPI router for HTTP endpoints
    database.py            # Optional schema helpers
  frontend/                # Optional client-side code
    src/plugin.js          # Source entry
    package.json           # Plugin-local Vite project
    vite.config.js         # Vite lib mode (IIFE output)
    dist/plugin.js         # Built output (gitignored)
```

The `id` field uses dotted reverse-DNS form (`{org}.{slug}`). It must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$` — no colons, no slashes.

---

## 3. Manifest

`manifest.json` lives at the plugin root and provides cosmetic data (name, description, author) plus the frontend entry/styles for filesystem fallback. The **security-relevant** fields (permissions, room_types, published_events, subscriptions) come from the runtime manifest the plugin sends in its `hello` frame — the bus hashes those and compares against the approval record.

```jsonc
{
  "id": "myorg.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does something useful.",
  "author": "MyOrg",
  "entry": "frontend/dist/plugin.js",      // frontend bundle
  "styles": ["frontend/dist/plugin.css"],

  "permissions": [
    "bus.send",
    "bus.receive",
    "http.routes",
    "storage.read",
    "storage.write"
  ],
  "room_types": ["my-type"],               // for room-type plugins
  "published_events": ["item_created"],    // events other plugins may subscribe to
  "subscriptions": [                       // events this plugin listens for
    "core:room_deleted",
    "four43.room-type-chat:message"
  ],

  "hooks": {}
}
```

### Manifest hashing

`backend/skrib/plugin_bus/approvals.py:_manifest_hash` hashes only the security-relevant fields:

- `id`, `version`
- `permissions`
- `published_events`, `subscriptions`
- `room_types`

Editing `name`, `description`, `entry`, `styles`, `hooks`, etc. does **not** trigger re-approval. Changing any of the hashed fields drops the plugin back to `pending` until an admin re-approves.

---

## 4. Permissions

The bus rejects every frame whose required permission isn't in the manifest. The full list (`VALID_PERMISSIONS` in `protocol.py`):

| Permission | Grants |
|---|---|
| `bus.send` | Emit any `bus.*` outbound frame (broadcast room, notify user/all, reply, emit event). |
| `bus.receive` | Receive `event` frames from cross-plugin subscriptions. **Required** even if you declared `subscriptions` — without it the bus drops events for you. |
| `room_type.register` | Send `register.room_type` to claim ownership of a room type. |
| `http.routes` | Receive proxied HTTP requests at `/api/plugins/{id}/*` (the SDK starts a local FastAPI server). |
| `storage.read` / `storage.write` | Use the per-plugin SQLite database. The bus does not enforce these on the file system — they're advisory and surface in the manifest review. |
| `core_api` | Send `core_api.request` frames to query users, rooms, presence. |
| `frontend.register` | Send `register.frontend` to declare scripts/styles served at `/api/plugins/{id}/file/...`. |
| `settings.register` | Send `register.settings` to declare a typed settings schema. |
| `callbacks.register` | Send `register.callback` for a callback endpoint that core can RPC into. |

Undeclared operations come back as:

```json
{
  "type": "error",
  "code": "permission_denied",
  "message": "Permission 'storage.write' required for 'bus.broadcast_room'",
  "request_id": "abc123"
}
```

### Namespace spoofing protection

When a plugin sends `bus.emit_event` with an `event_type` that already contains a `:`, the bridge rejects any prefix that isn't the plugin's own id or the privileged `core` namespace. Bare event names are auto-namespaced as `{plugin_id}:{event}`. See `bridge.py:_handle_emit_event`.

---

## 5. Connection lifecycle

```
SDK starts  ─►  open WS to bus  ─►  send hello  ─►  receive hello_ack
                                                       │
                                                       ▼
                                       ┌── status == "approved"  ──► register frames + on_connect → message loop
                                       ├── status == "pending"   ──► (run) close & exit  /  (run_forever) keep WS open and wait for activation
                                       └── status == "rejected"  ──► raise ConnectionError
```

`run_forever` reconnects with exponential backoff (1s → 30s, ×2). On every successful connect the SDK re-sends registration frames (`register.room_type`, `register.frontend`, `register.settings`, `register.callback`).

When a `pending_approval` plugin is later approved, the bus sends a second `hello_ack` over the still-open socket with `status: approved` and the SDK proceeds with registrations. There is no separate "activation" frame — it's just a second `hello_ack`.

### `hello` (plugin → bus)

```json
{
  "type": "hello",
  "plugin_id": "myorg.my-plugin",
  "version": "1.0.0",
  "secret": "<64-hex-char shared secret>",
  "manifest": { "id": "myorg.my-plugin", "version": "1.0.0", "permissions": [...], ... },
  "http_base_url": "http://127.0.0.1:51234"      // optional, only if the plugin serves HTTP
}
```

The secret is generated by core when an admin first approves the plugin and written to `data/plugin-secrets/{plugin_id}.secret` (file mode `0o600`). The SDK reads it from `SKRIB_PLUGIN_SECRET` (env var) or that file. On first connect (no approval record yet) the secret is ignored and the plugin enters `pending`.

`http_base_url` **must** resolve to a localhost address — the proxy refuses to forward to anything else (`PluginAuthMiddleware._is_localhost_url`).

### `hello_ack` (bus → plugin)

```json
{
  "type": "hello_ack",
  "status": "approved",                            // or "pending_approval" / "rejected"
  "config": { "max_message_size": 65536 },         // present when status=approved
  "message": "..."                                 // present when not approved
}
```

`max_message_size` is also enforced at the websockets layer (`max_size=65536`). Frames bigger than that close the connection with code 1009 before this server sees them.

### `goodbye` (plugin → bus)

A graceful shutdown signal. The bus closes the connection with code 1000 and removes registrations. Pending plugins are allowed to send `goodbye` (it's the only frame they may send before approval).

---

## 6. Frame protocol reference

All frames are JSON objects with a `type` field. Frames that expect a response carry a `request_id` (12-char hex). `validate_frame` in `protocol.py` enforces required fields per type.

Identifiers (`action`, `event_type`, `room_type`, etc.) match `SAFE_IDENTIFIER_RE = ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`. Subscription event names additionally allow `:` (`SAFE_SUBSCRIPTION_RE`).

### Plugin → Core (outbound)

| Frame `type` | Required permission | Required fields | Purpose |
|---|---|---|---|
| `bus.broadcast_room` | `bus.send` | `room_id`, `action` | Send `{plugin_id}:{action}` to every client currently joined to the room. Optional `exclude_user`. |
| `bus.notify_user` | `bus.send` | `username`, `action` | Send to all of one user's connected sockets. |
| `bus.notify_all` | `bus.send` | `action` | Send to every connected user. |
| `bus.reply` | `bus.send` | `reply_to`, `action` | Reply to the specific WebSocket that initiated the in-flight `room.action` (use the `reply_to` token from the inbound frame). |
| `bus.emit_event` | `bus.send` | `event_type` | Internal cross-plugin event. `event_type` is auto-namespaced unless it already contains `:`. The bridge also re-emits to other subscribed plugins. |
| `register.room_type` | `room_type.register` | `room_type`, `display_name` | Optional: `icon`, `description`. Conflicts (another plugin already owns the room type) are rejected. The room_type must appear in `manifest.room_types`. |
| `register.frontend` | `frontend.register` | `scripts` | Optional `styles`. Tells core which paths to serve at `/api/plugins/{id}/file/...`. |
| `register.settings` | `settings.register` | `settings` | Settings schema (see §9). |
| `register.callback` | `callbacks.register` | `endpoint` | Declares a callback endpoint core can RPC. Endpoint is a free-form string the plugin uses to dispatch (e.g. `/unread-count`). |
| `core_api.request` | `core_api` | `method`, `request_id` | RPC into core. See §8. |
| `core_api.response` | — | `request_id` | Currently unused; reserved for plugin → plugin RPC if added later. |
| `callback.response` | — | `request_id` | Reply to a `callback.request` from core. |
| `goodbye` | — | — | Graceful disconnect. |

### Core → Plugin (inbound)

| Frame `type` | Sent when | Notable fields |
|---|---|---|
| `hello_ack` | After hello, after admin approval, or on rejection. | `status`, optionally `config`, `message`. |
| `room.action` | A client sent `room:{action}` into a room of the plugin's registered type. | `room_id`, `action`, `username`, `reply_to`, `user_role`, `room_role`, `data` (the original client message). |
| `lifecycle.room_created` | Room of plugin's type was created. | `room_id`, `room_type`, `creator`. Sent only to that room-type's owner plugin. |
| `lifecycle.room_deleted` | Room was deleted. | `room_id`, `room_type`. |
| `lifecycle.user_joined` | User joined a room of plugin's type. | `room_id`, `username`. |
| `lifecycle.user_left` | User left a room of plugin's type. | `room_id`, `username`. |
| `callback.request` | Core needs the plugin to compute something synchronously. | `request_id`, `endpoint`, `data`. Reply with `callback.response` containing the same `request_id`. |
| `event` | A subscription matched an emitted bus event. | `event_type` plus the emitted payload fields. Requires `bus.receive`. |
| `config.updated` | Admin or user changed a setting. | `plugin_id`, `key`, `value`. |
| `error` | Anything went wrong (validation, permissions, rate limit). | `code`, `message`, optional `request_id`. |

### Example: `room.action` flow

```
Client                    Core                    Plugin Bus              Chat Plugin
  │                        │                         │                       │
  │ room:message           │                         │                       │
  │───────────────────────►│                         │                       │
  │                        │ room.action             │                       │
  │                        │ {reply_to, username,    │                       │
  │                        │  room_id, action,       │                       │
  │                        │  user_role, room_role,  │                       │
  │                        │  data}                  │                       │
  │                        │────────────────────────►│  room.action          │
  │                        │                         │──────────────────────►│
  │                        │                         │                       │
  │                        │                         │  bus.broadcast_room   │
  │                        │                         │◄──────────────────────│
  │ four43.room-type-      │                         │                       │
  │ chat:message           │◄────────────────────────│                       │
  │◄───────────────────────│                         │                       │
```

`reply_to` is a short-lived token tied to the WebSocket that sent the action. Use `bus.reply` for "respond to the sender only" — for example to surface a validation error without broadcasting it.

---

## 7. Cross-plugin events

A plugin emits with `bus.emit_event`. The bridge:

1. Validates the event_type against `SAFE_SUBSCRIPTION_RE`.
2. Auto-namespaces (or lets `core:`/own-namespace pass through, rejects others).
3. Emits the event into core's WS bus (`{type: "{plugin_id}:{event}", ...}`) so internal listeners hear it.
4. Calls `broadcast_to_subscribers`, which delivers to every other plugin whose `subscriptions` list contains a prefix that matches **and** which has `bus.receive` permission.

The publisher's `published_events` list is checked: the bus drops events whose name isn't published (the `core:` namespace is always allowed because it represents core's own events). Subscriptions can match exactly or by prefix:

- `four43.room-type-chat:message` matches `four43.room-type-chat:message`
- `four43.room-type-chat` matches any `four43.room-type-chat:*`

Subscribers receive an `event` frame; route it through `@on_event(event_type)` in the SDK.

---

## 8. CoreAPI — querying core data

A plugin with `core_api` can query core via `core_api.request`. The bridge dispatches the `method` field to the in-process `CoreAPI` (`backend/skrib/plugin_bus/bridge.py:_call_core_api`).

| Method | Params | Returns |
|---|---|---|
| `get_room_members` | `room_id` | `list[str]` of usernames |
| `get_room_info` | `room_id` | full room dict (members + roles) or `null` |
| `get_notify_level` | `room_id`, `username` | `"all"` / `"mentions"` / `"none"` |
| `get_unread_count` | `room_id`, `username` | `int` |
| `mark_room_read` | `room_id`, `username`, `message_id` | `{ok: true}` |
| `is_user_connected` | `username` | `bool` |

Wire format:

```json
// request
{"type": "core_api.request", "request_id": "ab12cd34", "method": "get_room_members", "params": {"room_id": "general"}}

// response
{"type": "core_api.response", "request_id": "ab12cd34", "result": ["alice", "bob"]}

// or, on error
{"type": "core_api.response", "request_id": "ab12cd34", "error": "Room not found"}
```

The Python SDK exposes these as `await self.core_api.get_room_members(...)` etc.

---

## 9. Settings

Plugins register a typed schema once per connect. The bus stores the schema on the connection; admins/users edit values through HTTP routes; core notifies the plugin via `config.updated` frames.

```json
{
  "type": "register.settings",
  "settings": [
    {
      "key": "max_message_length",
      "label": "Maximum message length",
      "type": "number",                        // number | boolean | string | select
      "default": 4000,
      "scope": "server",                       // server | user
      "description": "Maximum characters per message"
    },
    {
      "key": "show_typing_indicators",
      "label": "Show typing indicators",
      "type": "boolean",
      "default": true,
      "scope": "user"
    }
  ]
}
```

| Scope | Read by | Set by | Storage |
|---|---|---|---|
| `server` | Anyone authenticated | Admins | `plugin_settings` table |
| `user` | The owning user | The owning user | `plugin_settings` table, keyed by username |

HTTP endpoints (`backend/skrib/plugins/settings_routes.py`):

| Method + Path | Auth | Purpose |
|---|---|---|
| `GET /api/plugins/{id}/settings/schema` | authenticated | Get the registered schema |
| `GET /api/plugins/{id}/settings` | admin | Get current server values (defaults merged) |
| `PATCH /api/plugins/{id}/settings` | admin | Update server values; emits `config.updated` for each changed key |
| `GET /api/plugins/{id}/settings/user` | authenticated | Get current user's values (defaults merged) |
| `PATCH /api/plugins/{id}/settings/user` | authenticated | Update user values; emits `config.updated` |

---

## 10. HTTP routes

A plugin with `http.routes` runs its own HTTP server (the SDK uses uvicorn on `127.0.0.1:{ephemeral}`), declares it in `hello`, and serves routes under any path. Core proxies `/api/plugins/{id}/*` to that server **only** if the plugin is approved and the URL points to localhost.

### Middleware decision path

```
Request → /api/plugins/{plugin_id}/...
  │
  ├─ Strip client x-skrib-* headers (anti-spoofing)
  ├─ Inject x-skrib-username, x-skrib-user-role, x-skrib-room-role from session token
  │
  ├─ Sub-path == /file/* or /manifest?
  │     YES → serve from filesystem (file proxy still localhost-checked)
  │
  ├─ Plugin bus-connected, approved, and http_base_url is localhost?
  │     YES → proxy to {http_base_url}/{sub_path}
  │           Body capped at MAX_PROXY_BODY (16 MiB → 413 over)
  │           On proxy connection failure → 502
  │
  └─ Otherwise → fall through to local FastAPI routes (returns 404 if none)
```

Inside a proxied request the plugin reads `x-skrib-username`, `x-skrib-user-role`, and `x-skrib-room-role` (when the path contains `/rooms/{id}`). The SDK's `skrib.plugins.auth` helpers wrap that:

```python
from skrib.plugins.auth import plugin_user, require_room_member, can_edit_resource
```

### File serving

`GET /api/plugins/{id}/file/{path}` serves frontend assets. If the plugin registered `frontend_scripts`/`styles` via `register.frontend`, those win; otherwise routes fall back to `manifest.json`'s `entry`/`styles`. Bytes are fetched from the plugin's local HTTP server first, then from `backend/plugins/{id}/{path}` on disk. Path traversal is blocked.

---

## 11. Approval workflow

```
plugin connects ──► hash(manifest_security_fields)
                          │
                          ▼
       ┌──── existing record? ────────┐
       NO                              YES
       │                                │
       ▼                                ▼
 INSERT pending          ┌── status & hash unchanged?
                         │                 │
                         YES               NO
                         │                 │
                         ▼                 ▼
                    return status      UPDATE → pending
                                       (manifest changed)
```

Lifecycle states: `pending` → `approved` | `rejected` | `disabled`.

Admin endpoints (`backend/skrib/admin/routes.py`, all require admin role):

| Method + Path | Purpose |
|---|---|
| `GET /api/admin/plugins` | List every approval record |
| `GET /api/admin/plugins/pending` | Pending plugins awaiting review |
| `GET /api/admin/plugins/approved` | Approved plugins |
| `GET /api/admin/plugins/{id}/manifest-diff` | Stored manifest for review |
| `POST /api/admin/plugins/{id}/approve` | Approve and (if connected) activate. Generates a 64-hex secret on first approval. |
| `POST /api/admin/plugins/{id}/reject` | Reject; disconnect if connected. |
| `POST /api/admin/plugins/{id}/disable` | Disable an approved plugin; disconnect. |
| `DELETE /api/admin/plugins/{id}` | Drop the approval record entirely (used to clear stale `pending` rows). |

### Public plugin management

| Method + Path | Auth | Purpose |
|---|---|---|
| `GET /api/plugins` | authenticated | List bus-connected and on-disk plugins |
| `GET /api/plugins/{id}/manifest` | authenticated | Fetch a single manifest |
| `GET /api/plugins/{id}/file/{path}` | authenticated | Frontend asset (proxied / filesystem fallback) |

### Secrets

- Stored in the `plugin_approvals.secret` column.
- Mirrored to `data/plugin-secrets/{plugin_id}.secret` (mode `0o600`).
- The SDK resolves the secret from `SKRIB_PLUGIN_SECRET` env var, then `{SKRIB_DATA_DIR}/plugin-secrets/{plugin_id}.secret` (default `backend/data`).
- Secrets are compared with `hmac.compare_digest`.

---

## 12. Storage

Each plugin gets its own SQLite database at `data/plugins/{plugin_id}.db`. Plugins manage their own schema. Core never touches plugin tables. The Python SDK provides:

```python
from skrib_plugin_sdk import get_plugin_db, init_schema, make_db_provider

# Define schema as a class attribute — auto-applied on startup
class MyPlugin(SkribPlugin):
    table_schema = """
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ...
        );
    """

# Inside handlers:
with self.get_plugin_db() as conn:
    conn.execute("INSERT INTO items ...")
    conn.commit()
```

Connections are pooled per-thread; `close_all_connections()` is exposed for test fixtures.

---

## 13. Rate limits and size limits

| Limit | Where | Behaviour when exceeded |
|---|---|---|
| Connection rate per IP | `PluginBusServer._check_connection_rate` (10 hellos / 60s, localhost exempt) | 4029 close on the new connection |
| Frame rate per plugin | Token bucket (100 msg/s, burst 200) in `rate_limit.py` | `error` frame with code `rate_limited`; frame dropped |
| WebSocket frame size | `MAX_MESSAGE_SIZE = 65 536` bytes | Connection closed with 1009 by the websockets layer |
| HTTP proxy request body | `MAX_PROXY_BODY = 16 MiB` (`middleware.py`) | 413 Payload Too Large |

---

## 14. Python SDK reference

### `SkribPlugin` class attributes

| Attribute | Purpose |
|---|---|
| `id`, `version` | Required. |
| `permissions` | List of permission strings declared in the runtime manifest. |
| `room_types` | List of room types this plugin handles (matches manifest.room_types). |
| `room_type_meta` | `{room_type → {display_name, icon, description}}`. Optional per-room metadata override; falls back to the on-disk manifest's `name`/`description` for single-room plugins. |
| `published_events` | Event names this plugin emits. |
| `subscriptions` | Event names this plugin listens for (`plugin_id:event` or `core:event`). |
| `frontend_scripts`, `frontend_styles` | Override on-disk `entry`/`styles` via `register.frontend`. |
| `settings` | Settings schema sent in `register.settings`. |
| `callbacks_list` | Callback endpoints to register. |
| `table_schema` | SQL applied on startup. |
| `http_port` | `0` to auto-assign an ephemeral port; `None` for no HTTP server. |

### Decorators

```python
from skrib_plugin_sdk import on_room_action, on_lifecycle, on_event, callback
```

| Decorator | Argument | Triggered by |
|---|---|---|
| `@on_room_action(action)` | The action name (after `room:`) | Inbound `room.action` frame |
| `@on_lifecycle(event)` | `room_created`, `room_deleted`, `user_joined`, `user_left` | Inbound `lifecycle.*` frame |
| `@on_event(event_type)` | Full namespaced event (`plugin_id:event` or `core:event`) | Inbound `event` frame from a subscription |
| `@callback(endpoint)` | A free-form endpoint string | Inbound `callback.request` |

All handlers are async and receive a single `ActionContext` argument.

### `ActionContext`

Every handler receives a context that flattens the inbound frame for convenient access:

```python
@on_room_action("message")
async def handle_message(self, ctx):
    ctx.room_id          # str
    ctx.username         # str — the user who triggered the action
    ctx.action           # str — the bare action name
    ctx.reply_to         # str — token to use with bus.reply
    ctx.user_role        # str — global role (admin/moderator/user)
    ctx.room_role        # str — role in this room (owner/op/member/"")
    ctx.data             # dict — original client payload merged with frame fields
    ctx.bus              # PluginBus — see below
    ctx.get(key, default)  # dict-style access into ctx.data
```

### `PluginBus` methods

`ctx.bus` (a.k.a. `self.bus`) is the canonical handle for sending frames:

```python
await ctx.bus.broadcast_to_room(room_id, action, *, exclude_user=None, **fields)
await ctx.bus.notify_user(username, action, **fields)
await ctx.bus.notify_all(action, **fields)
await ctx.bus.reply(reply_to, action, **fields)
await ctx.bus.send_error(reply_to, message, room_id="")
await ctx.bus.emit_event(event_type, **fields)            # bare name → auto-namespaced
await ctx.bus.emit_event({"type": "core:something", ...}) # dict form for the core: namespace
```

The action sent to clients is `{plugin_id}:{action}`; the frontend filters by that prefix.

### `CoreAPI` methods

```python
await self.core_api.get_room_members(room_id)         # list[str]
await self.core_api.get_room_info(room_id)            # dict | None
await self.core_api.get_notify_level(room_id, user)   # str
await self.core_api.get_unread_count(room_id, user)   # int
await self.core_api.mark_room_read(room_id, user, message_id)
await self.core_api.is_user_connected(username)       # bool
```

### Run modes

```python
plugin = MyPlugin()
await plugin.run("ws://127.0.0.1:9000")           # connect once, exit on disconnect
await plugin.run_forever("ws://127.0.0.1:9000")   # reconnect with backoff
```

`run_forever` is what `__main__.py` uses in production. The SDK calls `on_connect`/`on_disconnect` overrides around the message loop.

---

## 15. Frontend integration

### Loading

`frontend/src/app.js`:

1. `GET /api/plugins` returns the list of plugins (bus-connected first, on-disk fallback for unconnected).
2. For each plugin with an `entry`, a `<script src="/api/plugins/{id}/file/{entry}">` is injected into the page.
3. The plugin must expose `window["{Pid}Plugin"].init(context)` (where `Pid` is the plugin id with first char upper-cased).

`init` returns a Promise; resolve once setup is done.

### Plugin context

The `init` argument is a fixed shape:

| Field | Notes |
|---|---|
| `sendWs(msg)` / `sendMessage(msg)` | Send a frame on the client WebSocket. |
| `registerHandler(type, fn)` | Subscribe to an inbound WS frame `type`. |
| `registerRoomTypeHandler(config)` | Room-type plugins only — wires render hooks. |
| `currentRoom()`, `currentUsername()`, `roomMeta()`, `currentRole()` | State getters. |
| `sessionToken()`, `roomKeys()`, `privateKey()`, `userColors()`, `userNicknames()` | More state getters. |
| `displaySystemMessage(text)` | Render a system message in the active room. |
| `loadRooms()`, `loadRoomKeys()` | Trigger a sidebar / key refresh. |
| `escapeHtml(str)`, `getDisplayName(username)` | Helpers. |
| `slashCommands()` | Shared slash-command registry for autocomplete. |
| `encryptMessage`, `decryptMessage`, `isEncryptedMessage`, `getMessageEpoch` | E2E crypto wrappers. |
| `API_URL` | Base API origin. |

State is exposed via getters (not direct references) so plugins can't capture stale state. Plugins are loaded as plain `<script>` tags (not modules) to keep core internals out of reach.

### Per-plugin Vite project

Each plugin with a frontend is its own npm project under `frontend/`. `frontend/util/install-plugins`, `frontend/util/build`, and `frontend/util/dev` orchestrate plugin builds alongside the main app. Manifests reference `frontend/dist/plugin.js` (the built artifact).

---

## 16. Implementation map

| File | Role |
|---|---|
| `backend/skrib/plugin_bus/server.py` | WebSocket bus server (port 9000) |
| `backend/skrib/plugin_bus/bridge.py` | Core-side bridge (frames ↔ WS manager + CoreAPI) |
| `backend/skrib/plugin_bus/protocol.py` | Frame types, validation, permission map |
| `backend/skrib/plugin_bus/approvals.py` | Approval state machine |
| `backend/skrib/plugin_bus/settings.py` | Server / user settings storage |
| `backend/skrib/plugin_bus/rate_limit.py` | Token bucket |
| `backend/skrib/plugins/middleware.py` | `PluginAuthMiddleware`, HTTP proxy |
| `backend/skrib/plugins/routes.py` | `/api/plugins` listing + file serving |
| `backend/skrib/plugins/settings_routes.py` | `/api/plugins/{id}/settings/*` |
| `backend/skrib/plugins/auth.py` | Plugin-side auth helpers (read injected headers) |
| `backend/skrib/plugins/core_api.py` | In-process `CoreAPI` (called by bridge) |
| `backend/skrib/admin/routes.py` | Admin approval API |
| `backend/skrib_plugin_sdk/plugin.py` | `SkribPlugin` base, lifecycle, registration |
| `backend/skrib_plugin_sdk/client.py` | Bus WebSocket client, reconnect |
| `backend/skrib_plugin_sdk/bus.py` | `PluginBus` (broadcast/notify/reply/emit) |
| `backend/skrib_plugin_sdk/core_api.py` | SDK's `CoreAPI` over bus frames |
| `backend/skrib_plugin_sdk/database.py` | Per-plugin SQLite helpers |
| `backend/skrib_plugin_sdk/http.py` | Plugin's own uvicorn server |
| `backend/skrib_plugin_sdk/loader.py` | Standalone-package loader |
| `frontend/src/app.js` | Frontend plugin loader + context |

---

## 17. Building a new plugin

1. Pick a namespaced id (`myorg.my-feature`) and create `backend/plugins/myorg.my-feature/`.
2. Write `manifest.json` with cosmetic metadata, plus `entry`/`styles` if you have a frontend.
3. Write `backend/plugin_bus.py` with a `SkribPlugin` subclass — declare `permissions`, `room_types`, `published_events`, `subscriptions`, etc.
4. Write `__main__.py` using `skrib_plugin_sdk.loader.load_plugin_class` and call `await plugin.run_forever()`.
5. (Optional) Add HTTP routes via `register_routes(self, app)` returning an `APIRouter`. Set `http_port = 0` so the SDK starts the HTTP server.
6. (Optional) Frontend: create `frontend/src/plugin.js` exporting `window["{Id}Plugin"].init(ctx)`.
7. Start the plugin: `python backend/plugins/myorg.my-feature/__main__.py` or `backend/util/start-plugins`.
8. The plugin enters `pending`. An admin approves it via `POST /api/admin/plugins/myorg.my-feature/approve`. Core writes the secret file; the SDK's next reconnect uses it.

For development, `backend/util/run-plugins.py` runs every bundled plugin in a single asyncio loop (one process, easier debugging). `backend/util/start-plugins` runs them as separate subprocesses (closer to production).

---

## 18. Worked example — typing indicator

A minimal feature plugin that broadcasts typing state without storage.

`backend/plugins/myorg.typing/manifest.json`:

```json
{
  "id": "myorg.typing",
  "name": "Typing Indicators",
  "version": "1.0.0",
  "description": "Show who is typing in a room.",
  "author": "MyOrg",
  "permissions": ["bus.send", "bus.receive"],
  "published_events": ["user_typing"]
}
```

`backend/plugins/myorg.typing/backend/plugin_bus.py`:

```python
import time
from skrib_plugin_sdk import SkribPlugin, on_room_action

class TypingPlugin(SkribPlugin):
    id = "myorg.typing"
    version = "1.0.0"
    permissions = ["bus.send", "bus.receive"]
    published_events = ["user_typing"]

    def __init__(self):
        super().__init__()
        self._last_seen: dict[tuple[str, str], float] = {}

    @on_room_action("typing")
    async def handle_typing(self, ctx):
        key = (ctx.room_id, ctx.username)
        now = time.monotonic()
        # Throttle to once every 2s per (room, user)
        if now - self._last_seen.get(key, 0) < 2.0:
            return
        self._last_seen[key] = now
        await ctx.bus.broadcast_to_room(
            ctx.room_id, "user_typing",
            exclude_user=ctx.username,
            username=ctx.username,
        )
```

`backend/plugins/myorg.typing/__main__.py`:

```python
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from skrib_plugin_sdk.loader import load_plugin_class

mod = load_plugin_class(os.path.dirname(os.path.abspath(__file__)))

async def main():
    plugin = mod.TypingPlugin()
    await plugin.run_forever(os.getenv("SKRIB_BUS_URL", "ws://127.0.0.1:9000"))

if __name__ == "__main__":
    asyncio.run(main())
```

Clients send `{"type": "room:typing", "room_id": "general"}`. The plugin emits `myorg.typing:user_typing` and every other user in the room receives it; their frontend renders a "Alice is typing…" indicator.

---

## 19. Design decisions

- **Bus transport**: plain WebSocket. Skrib already uses WebSockets for the client bus — same infrastructure, no broker to operate. Messages are ephemeral, so durability isn't needed.
- **Language-agnostic protocol**: JSON frames over WebSocket. The Python SDK is a convenience; any language that can open a WebSocket can be a plugin.
- **Storage**: plugin-owned. Local plugins get a SQLite path; remote plugins bring their own database. No storage RPC over the bus — too much complexity for too little benefit.
- **Frontend isolation**: plain `<script>` tags + a frozen context object. Iframe sandboxing was rejected because plugins need DOM access (message rendering, input handling, etc.).
- **Permissions**: declarative in the manifest, enforced per-frame at the bus. Subscriptions additionally require `bus.receive`. Plugins cannot emit into namespaces they don't own (except the privileged `core:`).
- **Approval**: required before any frame except `goodbye`. Manifest hash gates re-approval — cosmetic edits don't bother the admin; permission/subscription edits do.

---

## 20. Testing

- **Unit tests** (`backend/tests/unit/plugin_bus/`) cover the bus server, bridge, protocol, SDK, approvals, settings, middleware, `InProcessHost`, and `PluginRegistry`. Run with `cd backend && python -m pytest tests/unit/plugin_bus -v`.
- **E2E tests** (`frontend/tests/e2e/`) spawn a real subprocess for every bundled plugin whose manifest declares `runtime: "process"` (six today) and wait for each to connect before running — see `discoverBundledPlugins`/`waitForPluginsReady` in `frontend/tests/e2e/fixtures.js`. Plugins declaring `runtime: "in_process"` (`four43.room-type-chat`) are **not** spawned as subprocesses — they're loaded in-interpreter by the backend itself as part of normal startup, so there's nothing for the harness to wait on.
- To run with all bundled `process` plugins as separate subprocesses: `cd backend && ./util/start-plugins`. To stop: `./util/start-plugins --stop`.
- For a single-process debugging session (one event loop, all `process` plugins): `cd backend && python util/run-plugins.py`.
- Both launchers skip `runtime: in_process` plugins — see §1a.

---

## 21. Known limitations

- **No watchdog/restart**: if a plugin process dies, nothing brings it back. `start-plugins` is one-shot. Track this when running anywhere production-shaped.
- **No `bus.send` granularity**: a single permission covers room broadcast, user notify, and notify-all. Splitting into `bus.send.room` / `bus.send.user` / `bus.send.all` is on the roadmap.
- **No per-room rate limiting**: the token bucket is per-plugin only.
- **No metrics endpoint**: rate-limited frame counts and bus throughput aren't surfaced anywhere yet.
- **Lifecycle event broadcasting is asymmetric**: `core:room_created` etc. are emitted onto core's WS bus but only delivered to the room-type owner plugin via `lifecycle.*` frames. Subscriptions listing `core:room_deleted` may not currently fire — audit before relying on them.
