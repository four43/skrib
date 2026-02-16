# Plugin System Overview

Mini Chat uses a plugin architecture to extend functionality without modifying core code. Plugins can add new room types (e.g., chat, whiteboard), cross-cutting features (e.g., typing indicators, reactions), REST endpoints, and frontend UI.

## Plugin Structure

Each plugin lives in `backend/plugins/{plugin-id}/` using reverse-domain naming:

```
backend/plugins/com.four43.example-plugin/
  manifest.json           # Required: metadata
  backend/
    plugin.py             # Required: Plugin subclass
    services.py           # Optional: business logic
    routes.py             # Optional: REST endpoints
    ws_handlers.py        # Optional: WebSocket handlers
    database.py           # Optional: DB operations
  frontend/
    plugin.js             # Required: frontend entry point
    plugin.css            # Optional: styles
```

### Manifest

The `manifest.json` declares metadata and frontend integration:

```json
{
  "id": "com.four43.message-reactions",
  "name": "Message Reactions",
  "version": "1.0.0",
  "description": "Add emoji reactions to messages",
  "author": "Four43",
  "entry": "frontend/plugin.js",
  "permissions": ["websocket.send", "websocket.receive", "dom.messages"],
  "hooks": {"onRoomChange": true}
}
```

The `entry` field is the path (relative to the plugin directory) to the frontend script. The `permissions` and `hooks` fields are declarative metadata.

## Authoring a Plugin

### Backend: The Plugin Base Class

Every plugin extends the abstract `Plugin` class from `mini_chat.plugins.base`:

```python
from mini_chat.plugins.base import Plugin

class MyPlugin(Plugin):
    @property
    def id(self) -> str:
        return "com.four43.my-plugin"

    @property
    def name(self) -> str:
        return "my-plugin"

    @property
    def version(self) -> str:
        return "1.0.0"
```

**Identity** (required abstract properties):

- `id` -- Reverse-domain plugin ID (must match directory name)
- `name` -- Short identifier
- `version` -- Semver string

**Capabilities** (optional overrides):

- `room_types` -- Room type strings this plugin provides (e.g., `["chat"]`)
- `capabilities` -- Capability names this plugin provides (e.g., `["chat_messages"]`)
- `dependencies` -- Capability names required from other plugins

**Extension points** (optional, no-op defaults):

- `register_routes(app)` -- Return a FastAPI `APIRouter` for REST endpoints
- `register_ws_namespace(bus)` -- Register a WebSocket namespace handler
- `handle_room_action(bus, ws, username, msg, action)` -- Handle WS actions for this plugin's room types
- `intercept_message(message_data)` -- Modify or block messages before save
- `get_frontend_assets()` -- Return `{scripts, styles, config}` dict

**Lifecycle hooks** (optional, async):

- `on_startup()` / `on_shutdown()` -- App start/stop
- `on_enable()` / `on_disable()` -- Runtime toggle

**Event hooks** (optional, sync):

- `on_room_created(room_id, room_type, creator)`
- `on_room_deleted(room_id, room_type)`
- `on_message_sent(room_id, message_data)`
- `on_user_joined_room(room_id, username)` / `on_user_left_room(room_id, username)`

### Frontend: Registering with the Plugin Context

Frontend plugins are plain scripts (not ES modules) loaded via `<script>` tag injection at runtime. A plugin exposes itself on `window` using the naming convention: plugin ID `com.four43.example` becomes `window["Com.four43.examplePlugin"]`.

The plugin object must have an `init(ctx)` method. The context provides:

```javascript
window["Com.four43.myPluginPlugin"] = {
    init(ctx) {
        // ctx.registerHandler(namespace, handler)       -- register a WS namespace handler
        // ctx.registerRoomTypeHandler({...})             -- register a room type handler
        // ctx.sendWs(msg)                               -- send a WS message (JSON object)
        // ctx.currentRoom(), ctx.currentUsername()       -- state accessors
        // ctx.sessionToken(), ctx.API_URL                -- for REST calls
        // ctx.displaySystemMessage(text)                 -- show system message in chat
        // ctx.escapeHtml(str)                            -- XSS prevention
        // ctx.encryptMessage(), ctx.decryptMessage()     -- E2E encryption helpers
    }
};
```

There are two types of frontend handlers:

**Namespace handlers** -- for feature plugins that operate on their own WS namespace:

```javascript
ctx.registerHandler('com.four43.my-plugin', function(action, data, ctx) {
    if (action === 'update') { /* handle update */ }
});
```

**Room type handlers** -- for plugins that own a room type:

```javascript
ctx.registerRoomTypeHandler({
    roomTypes: ['chat'],
    onRoomSelected(roomId, roomMeta) { /* load room UI */ },
    onRoomLeft(roomId) { /* cleanup */ },
    onRoomAction(action, data) { /* handle room:* WS messages */ },
    onSendMessage(roomId, content) { /* handle user input submission */ },
});
```

### Discovery and Registration

On app startup, the `PluginRegistry`:

1. Scans the `backend/plugins/` directory for subdirectories
2. Reads each `manifest.json` and checks the enable/disable setting
3. Dynamically imports `backend/plugin.py` and finds `Plugin` subclasses
4. For each plugin: validates dependencies, creates database tables, registers room types and capabilities
5. Mounts REST routes at `/api/plugins/{plugin.id}/...`
6. Registers WebSocket namespace handlers on the shared bus
7. Calls `on_startup()` lifecycle hooks

Enable/disable state is persisted in the core `settings` table (key: `plugin:{id}:enabled`). Toggling requires a restart to take effect.

## Messaging

All real-time communication flows through a single WebSocket connection per client. Messages use the format `namespace:action` in the `type` field.

### Two Dispatch Paths

**Room-type plugins** receive messages through the core `room:` namespace. When a client sends `room:{action}`, the core handler:

1. Looks up the room's type from metadata
2. Finds the plugin registered for that room type
3. Calls `plugin.handle_room_action(bus, ws, username, msg, action)`

```python
# In your room-type plugin:
async def handle_room_action(self, bus, ws, username, msg, action):
    if action == "message":
        room_id = msg["room_id"]
        # persist, then broadcast
        await bus.broadcast_to_room(room_id, {
            "type": "room:message",
            "room_id": room_id,
            "data": {"username": username, "content": msg["content"]}
        })
```

**Feature plugins** register their own custom namespace and handle messages directly:

```python
def register_ws_namespace(self, bus):
    bus.register_namespace("com.four43.my-plugin", self.handle_ws)

async def handle_ws(self, bus, ws, username, msg):
    action = msg["type"].split(":", 1)[1]  # e.g., "com.four43.my-plugin:update" -> "update"
    # handle action...
```

### Broadcast Methods

The WebSocket bus provides three broadcast scopes:

- `bus.broadcast_to_room(room_id, message)` -- All sockets joined to a room
- `bus.notify_user(username, message)` -- All of a user's connected tabs/devices
- `bus.notify_all_users(message)` -- Every connected user

### Cross-Plugin Event Listening

Plugins can observe events from other plugins or core without intercepting them:

```python
bus.on_event("room:message", self.on_any_message)
```

### REST API

Plugins register HTTP routes via `register_routes()`. These are mounted at `/api/plugins/{plugin.id}/`:

```python
def register_routes(self, app):
    router = APIRouter()

    @router.get("/my-data")
    async def get_data(username: str = Depends(require_auth)):
        return {"data": "..."}

    return router
```

Plugin static files (JS, CSS) are served at `GET /api/plugins/{plugin_id}/file/{file_path}` with path traversal protection.

## Persistence

Each plugin has its own isolated SQLite database at `data/plugins/{plugin-id}.db`. Plugins never access the core database directly -- they use their own DB for plugin-specific data and call core services for shared data (rooms, users).

### Declaring a Table Schema

Override `get_table_schema()` to return a `CREATE TABLE IF NOT EXISTS` statement. The table is created in the plugin's own database automatically during registration:

```python
def get_table_schema(self) -> str:
    return """
        CREATE TABLE IF NOT EXISTS message_reactions (
            message_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (message_id, username, emoji)
        )
    """
```

Note: Foreign keys to core tables (messages, users) are not possible since each plugin has its own database file. Enforce referential integrity at the application level instead.

### Data Access

**Built-in helpers** from the base class (operate on the plugin's own DB):

```python
rows = self.execute_query("SELECT * FROM my_table WHERE id = ?", (some_id,))
self.execute_write("INSERT INTO my_table (col) VALUES (?)", (value,))
```

**Direct plugin database access** (complex queries, transactions):

```python
with self.get_plugin_db() as conn:
    conn.execute("INSERT INTO ...", params)
    conn.execute("CREATE INDEX IF NOT EXISTS ...")
    conn.commit()
```

**Core data access** -- Plugins should import core service functions (from `mini_chat.rooms.services`, etc.) rather than accessing the core database directly. This boundary enables eventual process isolation.

### Storage Patterns

- **No persistence** -- Typing indicators use in-memory dicts only
- **Plugin-scoped DB** -- Messages are stored in `data/plugins/com.four43.room-type-chat.db`; reactions in `data/plugins/com.four43.message-reactions.db`
- **Core settings table** -- Plugin enable/disable state is stored in core's `settings` table with keys like `plugin:{id}:enabled`

### Cross-Plugin Data Access

Core features that depend on plugin data (e.g., unread counts) call methods on the plugin instance through the registry. For example, the chat plugin exposes `get_unread_count()` and `get_unread_counts_batch()` which core's room services call to compute sidebar badges.

This pattern supports eventual process isolation -- these method calls would become RPC calls when plugins move to separate processes.

## Existing Plugins

| Plugin | Type | Persistence | Description |
|--------|------|-------------|-------------|
| `com.four43.room-type-chat` | Room Type | Own DB (`messages` table) | Text messaging, read receipts, E2E encryption |
| `com.four43.chat-typing` | Feature | None (in-memory) | Real-time typing indicators |
| `com.four43.message-reactions` | Feature | Own DB (`message_reactions` table) | Emoji reactions with real-time sync |

## CSS Namespacing

Frontend plugins use their reverse-domain ID as CSS class prefixes to avoid collisions:

```css
.com-four43-reactions-container { }
.com-four43-reaction-btn { }
#com-four43-chat-typing-indicator { }
```

## Admin API

- `GET /api/plugins` -- List all plugins with manifest data and enabled state
- `PATCH /api/plugins/{plugin_id}` -- Toggle enabled/disabled (admin only, requires restart)
- `GET /api/plugins/{plugin_id}/manifest` -- Get a plugin's manifest
- `GET /api/plugins/{plugin_id}/file/{path}` -- Serve plugin static files
