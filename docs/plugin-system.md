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
  backend/
    plugin.py            # Plugin class (extends SkribPlugin)
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

### SkribPlugin Base Class

All plugins extend `SkribPlugin` (defined in `backend/skrib/plugins/base.py`):

```python
class SkribPlugin(ABC):
    def __init__(self, plugin_id, manifest, bus, core_api, db_path):
        ...

    # Lifecycle hooks
    async def on_startup(self): ...
    async def on_shutdown(self): ...
    async def on_enable(self): ...
    async def on_disable(self): ...

    # Room lifecycle (for room-type plugins)
    async def on_room_created(self, room_id, created_by): ...
    async def on_room_deleted(self, room_id): ...

    # Message lifecycle
    async def on_message_sent(self, room_id, message): ...
    async def intercept_message(self, room_id, message): ...

    # Member lifecycle
    async def on_user_joined_room(self, room_id, username): ...
    async def on_user_left_room(self, room_id, username): ...

    # WebSocket action handler (room-type plugins)
    async def handle_room_action(self, action, data, username, room_id, ws): ...

    # HTTP routes (optional)
    def get_router(self) -> APIRouter: ...
```

### Plugin Discovery and Loading

1. At import time, `backend/skrib/plugins/registry.py` scans `backend/plugins/` for directories containing `manifest.json`
2. A synthetic Python package is created for each plugin
3. The plugin's `backend/plugin.py` is imported and the plugin class is instantiated
4. Each plugin receives its own `PluginBus`, `CoreAPI`, and database path

### Isolated Storage

Each plugin gets its own SQLite database at `data/plugins/{plugin_id}.db`. Plugins manage their own schema and migrations. Core tables are never shared.

### PluginBus

The `PluginBus` (defined in `base.py`) is a scoped wrapper around the WebSocket manager:

- **Namespace enforcement**: Outgoing events are auto-prefixed with the plugin ID (e.g., sending `message` from `four43.room-type-chat` becomes `four43.room-type-chat:message`)
- **Permission checks**: Each send/receive operation is validated against the manifest
- **Cross-plugin events**: Plugins can listen to events from other namespaces using `on_event()` / `off_event()`

### CoreAPI

The `CoreAPI` (defined in `core_api.py`) provides read access to core data for plugins that declare the `core_api` permission:

- Get user info, room details, room members
- Look up memberships and roles
- Access notification preferences

### Callback System

Core invokes plugin functionality through HTTP-style callbacks (`callbacks.py`) rather than direct method calls:

| Callback | Purpose |
|---|---|
| `/unread-count` | Get unread count for a user in a room |
| `/unread-counts-batch` | Batch unread counts for multiple rooms |
| `/intercept-message` | Content filtering before broadcast |
| `/health` | Plugin health check |

### PluginAuthMiddleware

An ASGI middleware (`middleware.py`) that authenticates requests to plugin routes:

1. Strips any client-supplied `x-skrib-*` headers (anti-spoofing)
2. Extracts the `Authorization: Bearer` token
3. Validates the session and injects trusted headers: `x-skrib-username`, `x-skrib-user-role`, `x-skrib-room-role`
4. Maintains a 30-second auth cache per token

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

- `GET /api/plugins` — list all plugins with manifests (authenticated)
- `PATCH /api/plugins/{plugin_id}` — enable or disable a plugin (admin only, requires server restart for full effect)

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/plugins/base.py` | SkribPlugin ABC, PluginBus |
| `backend/skrib/plugins/registry.py` | Plugin discovery and loading |
| `backend/skrib/plugins/core_api.py` | CoreAPI for plugin data access |
| `backend/skrib/plugins/callbacks.py` | Callback dispatcher |
| `backend/skrib/plugins/middleware.py` | PluginAuthMiddleware |
| `backend/skrib/plugins/routes.py` | Plugin management REST API |
| `backend/skrib/plugins/auth.py` | Plugin auth helpers |
| `frontend/src/app.js` (lines 53-285) | Frontend plugin loader and context |

## Writing a New Plugin

1. Create a directory under `backend/plugins/` with a namespaced ID (e.g., `myorg.my-feature`)
2. Write a `manifest.json` declaring permissions and entry points
3. Implement a plugin class extending `SkribPlugin` in `backend/plugin.py`
4. Optionally add HTTP routes via `get_router()`
5. Optionally add a `frontend/plugin.js` that exports an `init(context)` function on `window`
6. Restart the server — the plugin is auto-discovered and loaded
