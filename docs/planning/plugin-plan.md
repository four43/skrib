# Plugin Isolation: Architecture Roadmap

## Context

The [plugin-overview.md](../docs/plugin-overview.md) describes 3 things provided to plugins:

1. **Bus/Interface** — namespaced real-time messaging
2. **Persistence Directory** — isolated DB
3. **HTTP API** — proxied pre-authenticated requests

Goal: plugins should be isolatable to run in a separate process or Docker container. This document analyzes the gaps and proposes an HTTP-first approach that leverages the existing core API rather than building a custom RPC layer.

---

## Current Coupling: Every `from skrib.*` Import

| Import | Used By | Purpose |
|--------|---------|---------|
| `skrib.dependencies.require_auth` | chat, todo, reactions, web-push routes | Validate Bearer token |
| `skrib.permissions.get_global_role` | chat plugin | Check admin for delete |
| `skrib.permissions.can_edit_resource` | todo plugin | Check edit rights |
| `skrib.permissions.check_room_access` | chat routes | Validate room access |
| `skrib.permissions.check_room_membership` | todo routes | Validate membership |
| `skrib.permissions.require_edit_permission` | todo routes | Enforce edit permission |
| `skrib.rooms.services.get_room_members` | chat, web-push | Iterate members for notifications |
| `skrib.rooms.services.get_notify_level` | chat | Check notification preferences |
| `skrib.rooms.services.get_unread_count_for_room` | chat | Include unread counts in notifications |
| `skrib.rooms.services.mark_room_read` | chat routes | Update read position |
| `self._bus.user_connections` | web-push | Check if user has active WS |

Plus **reverse calls** (core -> plugin):

- `plugin.on_room_created/deleted/message_sent/user_joined/user_left`
- `plugin.get_unread_count()` / `get_unread_counts_batch()`
- `plugin.intercept_message()`
- `plugin.handle_room_action(bus, ws, username, msg, action)` — raw WebSocket passed

---

## HTTP-First Approach

Instead of building a custom bus RPC protocol, plugins and core communicate via HTTP in both directions. This is simpler, language-agnostic, and the core API already exists for most queries.

### Communication Model

```
┌──────────┐   HTTP (proxied)     ┌──────────┐
│  Client  │ ───────────────────► │   Core   │
└──────────┘                      │  (proxy) │
                                  │          │
                   ┌──────────────┤          ├──────────────┐
                   │  HTTP fwd    │          │  HTTP fwd    │
                   ▼              │          │              ▼
              ┌──────────┐         │          │       ┌──────────┐
              │ Plugin A │        │          │        │ Plugin B │
              │  (HTTP)  │        │          │        │  (HTTP)  │
              └────┬─────┘        │          │        └─────┬────┘
                   │              │          │              │
                   │  HTTP call   │          │  HTTP call   │
                   └─────────────►│          │◄─────────────┘
                    core API      │          │  core API
                                  │          │
                   Bus events     │          │   Bus events
              ◄───────────────────┤          ├──────────────────►
              (WS/real-time only) └──────────┘ (WS/real-time only)
```

**Three communication channels:**

1. **Client → Core → Plugin** (proxied HTTP, core handles auth)
2. **Plugin → Core** (plugin calls core's REST API for data it needs)
3. **Bus** (real-time events only — broadcasts, lifecycle, room actions)

### What the Core HTTP API Already Provides

Most of what plugins import is already available via HTTP:

| Plugin Import | Existing Core Endpoint | Notes |
|---------------|----------------------|-------|
| `get_room_members(room_id)` | `GET /api/rooms/{room_id}` | Returns `members: [{username, room_role, ...}]` |
| `get_global_role(username)` | `GET /api/users/{username}` | Returns user profile with `role` field |
| `check_room_access` | Implicit — proxy handles | If proxy validates membership, this is free |
| `check_room_membership` | Implicit — proxy handles | Same |
| `mark_room_read` | `PATCH /api/rooms/{room_id}/members/{username}` | Partially — notify_level exists, read position needs adding |

### What's Missing from Core HTTP API

| Need | Proposed Endpoint | Used By |
|------|-------------------|---------|
| Notify level per member | `GET /api/rooms/{room_id}/members/{username}` | chat plugin |
| User presence (WS connected?) | `GET /api/users/{username}/presence` | web-push plugin |
| Mark read position | `POST /api/rooms/{room_id}/read` (already exists in chat routes — move to core) | chat plugin |

### What Permissions Don't Need an API

With the proxy injecting auth context headers, plugins can compute permissions **locally**:

- `can_edit_resource(room_id, username, creator)` → Plugin knows the request user's `room_role` (from `X-Skrib-Room-Role`) and `global_role` (from `X-Skrib-User-Role`). Logic is: `username == creator OR room_role in (owner, op) OR global_role in (admin, moderator)`. No API call needed.

- `get_global_role(username)` for the **requesting user** → Already in `X-Skrib-User-Role`. For **other users** (e.g., checking a message author), call `GET /api/users/{username}`.

---

## What Each Pillar Needs

### Pillar 1: Bus — Real-Time Events Only (No RPC)

The bus stays simple — fire-and-forget messaging for real-time events. No request/response needed since HTTP handles queries.

**What's missing:**

1. **Lifecycle Events** — Instead of core calling `plugin.on_room_deleted()` directly, emit bus events:
   - `core:room_created {room_id, room_type, creator}`
   - `core:room_deleted {room_id, room_type}`
   - `core:user_joined {room_id, username}`
   - `core:user_left {room_id, username}`

2. **Declarative Event Subscriptions** — Manifest declares what events to receive:

   ```json
   {"subscriptions": ["core:room_deleted", "four43.room-type-chat:message"]}
   ```

3. **No Raw WebSocket References** — Replace `ws` parameter with `reply_to` token. `bus.send_error(reply_to, msg)` instead of `ws.send_json()`.

4. **Transport Abstraction** — Same event protocol over in-process calls, subprocess stdio, or network (Redis pub/sub, NATS, etc.)

### Pillar 2: Persistence — Already Good

Each plugin gets isolated SQLite at `data/plugins/{plugin_id}.db`. No changes needed.

Minor additions for later:

- Configuration storage (admin-settable plugin config)
- Resource limits (disk quota)

### Pillar 3: HTTP API — Bidirectional with Pre-Auth

**Client → Core → Plugin (inbound):**

1. **Auth at proxy layer** — Core validates Bearer token, injects:
   - `X-Skrib-Username: alice`
   - `X-Skrib-User-Role: admin`

2. **Room-scoped auth at proxy** — For routes with `{room_id}`, core validates membership and injects:
   - `X-Skrib-Room-Role: op`
   Declared in manifest:

   ```json
   {"routes": [{"path": "/rooms/{room_id}/messages", "auth": "room_member"}]}
   ```

3. **Actual HTTP proxy** — For out-of-process: forward to plugin's HTTP server. For in-process: passthrough (current behavior).

**Plugin → Core (outbound):**

1. **Internal API access** — Plugins call core's existing REST API to get data they need. Two options:
   - **Service token**: Plugin gets a long-lived internal token at startup (like a bot token)
   - **Request forwarding**: Plugin includes `X-Skrib-Plugin-Id` header, core trusts it (localhost only)

2. **Missing endpoints to add** (small):
   - `GET /api/users/{username}/presence` → `{connected: bool}`
   - `GET /api/rooms/{room_id}/members/{username}` → `{username, room_role, notify_level}`

**Core → Plugin (reverse HTTP):**

1. **Core calls plugin HTTP endpoints** for:
   - `POST /unread-count` `{room_id, since_message_id}` → `{count: int}` (replaces `plugin.get_unread_count()`)
   - `POST /unread-counts-batch` `{room_positions: {room_id: since_id}}` → `{room_id: count}`
   - `POST /intercept-message` `{message_data}` → `{message_data}` or `null`
   - `GET /health` → `200 OK`

---

## How Each Plugin Changes

### chat-typing (coupling: VERY LOW)

- **Currently**: No imports beyond `Plugin` base. Pure bus pub/sub.
- **Changes**: Minimal. Just use `reply_to` instead of `ws` for error responses.

### message-reactions (coupling: LOW)

- **Currently**: Imports `require_auth` only.
- **Changes**: Remove `require_auth`, trust proxy `X-Skrib-Username` header.

### room-type-todo (coupling: MEDIUM)

- **Currently**: Imports `require_auth`, `can_edit_resource`, `check_room_membership`, `require_edit_permission`.
- **Changes**: Remove auth imports (proxy handles). Compute edit permissions locally from `X-Skrib-Room-Role` + `X-Skrib-User-Role` + creator comparison.

### room-type-chat (coupling: MEDIUM)

- **Currently**: Imports `require_auth`, `get_global_role`, `check_room_access`, `get_room_members`, `get_notify_level`, `get_unread_count_for_room`, `mark_room_read`.
- **Changes**: Remove auth imports (proxy handles). Call `GET /api/rooms/{room_id}` to get members. Call `GET /api/rooms/{room_id}/members/{username}` for notify_level. Compute admin check from proxy headers for the requesting user, or call `GET /api/users/{username}` for other users. Move `mark_room_read` to core if needed.

### web-push (coupling: MEDIUM-HIGH)

- **Currently**: Imports `get_room_members`, accesses `self._bus.user_connections`.
- **Changes**: Call `GET /api/rooms/{room_id}` for members. Call `GET /api/users/{username}/presence` for connection check.

---

## Phased Approach

### Phase 1: Proxy Pre-Auth (biggest win, low effort)

- Add middleware that validates auth and injects `X-Skrib-Username`, `X-Skrib-User-Role`
- For routes with `{room_id}`, validate membership and inject `X-Skrib-Room-Role`
- Update plugins to read headers instead of importing `require_auth` / permission functions
- **Result**: Eliminates 6 of 11 coupling points (all auth + permission imports)

### Phase 2: Plugin → Core HTTP Calls

- Add missing endpoints: user presence, member notify_level
- Update chat + web-push plugins to call core HTTP API instead of importing Python functions
- **Result**: Eliminates remaining 5 coupling points (room services imports)

### Phase 3: Bus Lifecycle Events + Reply Tokens

- Emit lifecycle events on bus instead of calling plugin methods directly
- Replace `ws` parameter with `reply_to` tokens
- Declare event subscriptions in manifest
- **Result**: Core never calls plugin Python methods directly (except via bus events)

### Phase 4: Core → Plugin HTTP Callbacks

- Define plugin HTTP endpoints for unread counts, message interception
- Core calls plugin HTTP endpoints instead of Python methods
- **Result**: Full bidirectional HTTP + bus-only architecture

### Phase 5: Transport Abstraction + Out-of-Process

- Abstract bus transport (in-process → subprocess → network)
- Plugin SDK provides standalone HTTP server
- Test one plugin as a subprocess
- Docker Compose support
- **Result**: Plugins can run anywhere

---

## Cross-Cutting Improvements

Inspired by research into Discord, Slack, and Obsidian plugin systems (see [plugin-system-research.md](plugin-system-research.md)). These are independent of the phased decoupling work above and can be implemented alongside any phase.

### Auto-Cleanup Registration Pattern (from Obsidian)

**Priority: High | Effort: Low | Can start: Now**

Obsidian's standout design decision is that everything registered via `register*` methods is automatically cleaned up when a plugin unloads. Developers never manually track resources. This eliminates an entire class of resource leak bugs across 2000+ community plugins.

Skrib's `on_startup`/`on_shutdown` hooks exist, but plugins manually manage event listeners, routes, and other resources. Add registration methods to the `Plugin` base class that auto-clean on disable/shutdown:

```python
class Plugin:
    def __init__(self):
        self._registered_resources = []

    def register_event(self, event_name, handler):
        """Subscribe to a bus event. Auto-unsubscribed on plugin disable/shutdown."""
        self._bus.on_event(event_name, handler)
        self._registered_resources.append(("event", event_name, handler))

    def register_interval(self, seconds, callback):
        """Run a periodic task. Auto-cancelled on plugin disable/shutdown."""
        task = asyncio.create_task(self._run_interval(seconds, callback))
        self._registered_resources.append(("interval", task))

    def register_cleanup(self, callback):
        """Run arbitrary cleanup on disable/shutdown."""
        self._registered_resources.append(("cleanup", callback))

    async def _cleanup_all(self):
        """Called by framework on disable/shutdown. Plugins should NOT override this."""
        for resource in reversed(self._registered_resources):
            match resource[0]:
                case "event":
                    self._bus.off_event(resource[1], resource[2])
                case "interval":
                    resource[1].cancel()
                case "cleanup":
                    await resource[1]() if asyncio.iscoroutinefunction(resource[1]) else resource[1]()
        self._registered_resources.clear()
```

**Usage in plugins:**

```python
# Before (manual tracking, error-prone):
class ChatTyping(Plugin):
    async def on_startup(self):
        self._bus.on_event("core:room_deleted", self.handle_delete)

    async def on_shutdown(self):
        self._bus.off_event("core:room_deleted", self.handle_delete)  # easy to forget

# After (auto-cleanup):
class ChatTyping(Plugin):
    async def on_startup(self):
        self.register_event("core:room_deleted", self.handle_delete)
        # No on_shutdown needed — framework handles it
```

**Scope of `register_*` methods to add:**

| Method | Manages |
|--------|---------|
| `register_event(name, handler)` | Bus event subscriptions |
| `register_interval(seconds, cb)` | Periodic async tasks |
| `register_cleanup(cb)` | Arbitrary teardown callbacks |

Routes and WS handlers are already declarative (`register_routes()`, `get_ws_handler()`) and managed by the framework, so those don't need this pattern.

### Declarative Permission Enforcement (from Slack)

**Priority: High | Effort: Medium | Can start: Phase 1**

Slack's core security model ties every API method to a specific OAuth scope. Plugins declare what they need, users see what they're granting, and the platform enforces it. Obsidian has no enforcement at all — plugins get full system access — and this is widely cited as its biggest weakness.

Skrib's manifest already declares permissions (`"permissions": ["websocket.send", "dom.messages"]`) but they aren't enforced. The `PluginBus` wrapper is the natural enforcement point — it already scopes all outgoing messages to the plugin's namespace. Extend it to restrict capabilities based on declared permissions.

**Proposed capability set:**

| Permission | Grants | Enforcement Point |
|------------|--------|-------------------|
| `bus.send` | Send messages on the bus (broadcast to rooms, notify users) | `PluginBus` — disable `broadcast_to_room`, `notify_user`, `notify_all_users` |
| `bus.receive` | Receive bus events from other namespaces | `PluginBus` — filter incoming events |
| `bus.receive_room` | Receive room-scoped events (messages, joins, etc.) | `PluginBus` — filter room events |
| `http.routes` | Register HTTP endpoints that clients can call | Plugin route registration |
| `storage.read` | Read from plugin's isolated database | `get_plugin_db()` |
| `storage.write` | Write to plugin's isolated database | `execute_write()` |
| `core_api` | Call core REST API endpoints (plugin → core) | Internal HTTP client |

**Enforcement in `PluginBus`:**

```python
class PluginBus:
    def __init__(self, bus, plugin_id, permissions: list[str]):
        self._bus = bus
        self._plugin_id = plugin_id
        self._permissions = set(permissions)

    async def broadcast_to_room(self, room_id, action, **fields):
        if "bus.send" not in self._permissions:
            raise PermissionError(f"Plugin {self._plugin_id} lacks 'bus.send' permission")
        await self._bus.broadcast_to_room(room_id, f"{self._plugin_id}:{action}", **fields)

    async def notify_user(self, username, action, **fields):
        if "bus.send" not in self._permissions:
            raise PermissionError(f"Plugin {self._plugin_id} lacks 'bus.send' permission")
        await self._bus.notify_user(username, f"{self._plugin_id}:{action}", **fields)
```

**Manifest change:**

```json
{
  "id": "four43.chat-typing",
  "permissions": ["bus.send", "bus.receive_room"]
}
```

**Why start at Phase 1:** The proxy pre-auth work creates the `PluginBus` for each plugin with auth context. Adding permission checks to that same bus is a natural extension — the bus already knows the plugin's identity and manifest.

**Why not wait:** Every phase that adds new capabilities (HTTP callbacks in Phase 4, transport abstraction in Phase 5) becomes harder to secure retroactively. Enforcing permissions early means new features are secure by default.

---

## Summary

The 3 pillars are the right framework. The key missing piece is making the HTTP API **bidirectional** — plugins call core's API for data, core calls plugin's API for callbacks. This avoids building a custom RPC protocol entirely. The bus stays simple (real-time events only).

| Gap | Fix | Phase |
|-----|-----|-------|
| Plugins import `require_auth` | Proxy pre-auth + headers | 1 |
| Plugins import permission functions | Proxy injects room/user roles, compute locally | 1 |
| Plugins import `get_room_members` etc. | Plugin calls `GET /api/rooms/{room_id}` | 2 |
| Plugins access `bus.user_connections` | New `GET /api/users/{username}/presence` | 2 |
| Core calls `plugin.on_room_deleted()` directly | Bus lifecycle events | 3 |
| Core passes raw `ws` to plugins | `reply_to` tokens on bus | 3 |
| Core calls `plugin.get_unread_count()` | Core calls `POST /plugin/unread-count` | 4 |
| No process isolation | Transport abstraction + plugin HTTP server | 5 |
