# Plugin System Design

> **Superseded — retained for history.** Written 2026-02-18.
>
> The original plugin-system design. Superseded twice: first by the
> out-of-process migration (`ed3534f`..`47cbd8d`), then by
> `docs/spec/2026-08-02-extension-model.md`, which moves the process boundary to a
> per-plugin `runtime` manifest field and relocates message storage into core.
>
> Its "Phase 6: Plugin Marketplace (Future)" section is the only place in the whole
> doc set that ever posited third-party plugin authors — which is why the
> containment model built from this design had no user. Current reference:
> `docs/reference/plugin-system.md`.

---

## Overview

Design a plugin architecture that allows extending Skrīb with new room types, features, and UI customization without modifying core code.

## Goals

1. **Extensible Room Types**: Support chat, whiteboard, video, polls, etc. as plugins
2. **Feature Plugins**: Cross-cutting features like typing indicators, reactions, read receipts
3. **Backend + Frontend Plugins**: Full-stack plugin support
4. **Frontend-Only Plugins**: UI features without backend changes
5. **Event-Driven Architecture**: Plugins can listen to and broadcast events on the bus
6. **Theme System**: Configurable UI appearance
7. **Plugin Discovery**: Auto-load and register plugins
8. **Minimal Core Impact**: Avoid breaking existing functionality

## Plugin Categories

Plugins fall into several categories based on their purpose:

1. **Room Type Plugins**: Provide entirely new room types (e.g., whiteboard, video conference)
   - Register new `room_type` values
   - Provide custom rendering and interaction UI
   - May have dedicated API endpoints

2. **Feature Plugins**: Add features that work across all or multiple room types (e.g., typing indicators, reactions, message translation)
   - Don't create new room types
   - Extend existing rooms with additional functionality
   - Often ephemeral (no persistent state)

3. **API Extension Plugins**: Add new API endpoints without UI (e.g., analytics, export, webhooks)
   - Backend-only
   - May listen to bus events for data collection
   - Provide REST or GraphQL endpoints

4. **Event Listener Plugins**: React to events on the bus (e.g., moderation bots, logging, notifications)
   - Backend-only
   - Passive observers or active responders
   - May integrate with external services

5. **State Management Plugins**: Store and retrieve plugin-specific data (e.g., bookmarks, reminders, user notes)
   - Own database tables or storage
   - CRUD operations via API

6. **UI Enhancement Plugins**: Frontend-only visual or interaction improvements (e.g., emoji pickers, markdown preview, themes)
   - No backend component
   - Pure client-side enhancement

## Architecture Components

### 1. Plugin Registry (Backend)

**Location**: `backend/skrib/plugins/`

```python
# plugins/registry.py
class Plugin:
    """Base plugin interface."""

    @property
    def name(self) -> str:
        """Unique plugin identifier (e.g., 'whiteboard', 'polls')."""
        raise NotImplementedError

    @property
    def version(self) -> str:
        """Plugin version (semver)."""
        return "1.0.0"

    @property
    def room_types(self) -> list[str]:
        """Room types this plugin provides (e.g., ['whiteboard']).

        Return empty list if plugin doesn't provide room types.
        Most plugins won't implement this - only Room Type Plugins.
        """
        return []

    def register_routes(self, app) -> Optional[APIRouter]:
        """Return FastAPI router for plugin endpoints.

        Used by: API Extension Plugins, Room Type Plugins, State Management Plugins
        """
        return None

    def register_ws_namespace(self, bus: UnifiedConnectionManager):
        """Register WebSocket namespace handlers (e.g., 'whiteboard.*', 'typing.*').

        Plugins can:
        - Register their own namespace for bidirectional communication
        - Subscribe to events from other namespaces (listen-only)

        Used by: Feature Plugins, Room Type Plugins, Event Listener Plugins
        """
        pass

    def get_frontend_assets(self) -> dict:
        """Return frontend assets to inject into the client.

        Used by: All plugins with UI components
        """
        return {
            "scripts": [],  # List of JS file paths
            "styles": [],   # List of CSS file paths
            "config": {}    # JSON config for frontend
        }

    def on_room_created(self, room_id: str, room_type: str, creator: str):
        """Hook called when a room is created.

        Args:
            room_id: The room identifier
            room_type: The type of room (may or may not be this plugin's type)
            creator: Username who created the room

        Used by: Event Listener Plugins, State Management Plugins
        """
        pass

    def on_room_deleted(self, room_id: str, room_type: str):
        """Hook called when a room is soft-deleted.

        Used by: Event Listener Plugins, State Management Plugins (for cleanup)
        """
        pass

    def on_message_sent(self, room_id: str, message_data: dict):
        """Hook called when a message is sent to any room.

        Args:
            room_id: The room where message was sent
            message_data: Full message dict (id, username, content, timestamp, etc.)

        Used by: Event Listener Plugins, Moderation Plugins, Analytics Plugins
        """
        pass

    def on_user_joined_room(self, room_id: str, username: str):
        """Hook called when a user joins a room (sends room.join).

        Used by: Feature Plugins (e.g., presence indicators), Event Listener Plugins
        """
        pass

    def on_user_left_room(self, room_id: str, username: str):
        """Hook called when a user leaves a room (sends room.leave or disconnects).

        Used by: Feature Plugins (e.g., presence indicators)
        """
        pass


class PluginRegistry:
    """Central registry for all plugins."""

    def __init__(self):
        self.plugins: Dict[str, Plugin] = {}
        self.room_type_map: Dict[str, Plugin] = {}  # room_type -> plugin

    def register(self, plugin: Plugin):
        """Register a plugin."""
        self.plugins[plugin.name] = plugin
        for room_type in plugin.room_types:
            self.room_type_map[room_type] = plugin

    def get_plugin_for_room_type(self, room_type: str) -> Optional[Plugin]:
        """Get the plugin that handles a specific room type."""
        return self.room_type_map.get(room_type)

    def discover_plugins(self):
        """Auto-discover plugins in the plugins/ directory."""
        # Scan for plugin modules and auto-register
        pass

# Global registry instance
registry = PluginRegistry()
```

**Event Bus Enhancement for Cross-Namespace Listening**:

The `UnifiedConnectionManager` should be extended to support cross-namespace event observation:

```python
# In ws/manager.py
class UnifiedConnectionManager:
    def __init__(self):
        # ... existing fields ...
        self.event_listeners: Dict[str, List[Callable]] = {}  # event_type -> [callbacks]

    async def broadcast_to_room(self, room_id: str, message: dict):
        """Send a message to all sockets subscribed to a room."""
        sockets = self.room_subscriptions.get(room_id, set()).copy()
        disconnected = []
        for ws in sockets:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect(ws)

        # Trigger event listeners
        await self._trigger_event_listeners(message)

    async def notify_user(self, username: str, message: dict):
        """Send a message to all of a user's sockets (user-scoped)."""
        # ... existing code ...
        # Trigger event listeners
        await self._trigger_event_listeners(message)

    def on_event(self, event_type: str, callback: Callable):
        """Register a callback to be notified when an event of this type is broadcast.

        Args:
            event_type: The message type (e.g., "room.message", "typing.start")
            callback: Async function(event_data: dict) to call

        This allows plugins to observe events from other namespaces without
        intercepting the message flow.
        """
        if event_type not in self.event_listeners:
            self.event_listeners[event_type] = []
        self.event_listeners[event_type].append(callback)

    async def _trigger_event_listeners(self, message: dict):
        """Notify all registered listeners for this message type."""
        event_type = message.get("type")
        if event_type and event_type in self.event_listeners:
            for callback in self.event_listeners[event_type]:
                try:
                    await callback(message)
                except Exception as e:
                    print(f"[WS] Error in event listener for {event_type}: {e}")
```

**Usage**: Plugins can now observe events from any namespace:

```python
# In a plugin's register_ws_namespace method:
async def on_message(event):
    # React to messages sent in any room
    print(f"Message in {event['room_id']}: {event['data']['content']}")

bus.on_event("room.message", on_message)
```

### 2. Core Chat Plugin (Backend)

The existing chat functionality becomes a built-in plugin:

```python
# plugins/chat_plugin.py
class ChatPlugin(Plugin):
    """Core chat functionality as a plugin."""

    @property
    def name(self) -> str:
        return "chat"

    @property
    def room_types(self) -> list[str]:
        return ["channel", "dm"]

    def register_ws_namespace(self, bus: UnifiedConnectionManager):
        # Register the existing 'room' namespace handlers
        from ..ws.handlers import register_core_handlers
        register_core_handlers(bus)

    def get_frontend_assets(self) -> dict:
        return {
            "scripts": ["chat-plugin.js"],
            "config": {
                "features": ["encryption", "typing_indicators"]
            }
        }
```

### 3. Plugin Lifecycle Integration

**App Initialization** (`main.py`):

```python
from .plugins import registry
from .plugins.chat_plugin import ChatPlugin
from .plugins.whiteboard_plugin import WhiteboardPlugin  # Example

# Register built-in plugins
registry.register(ChatPlugin())

# Discover and register external plugins
registry.discover_plugins()

# Register all plugin routes
for plugin in registry.plugins.values():
    router = plugin.register_routes(app)
    if router:
        app.include_router(router, prefix="/api")

# Register all plugin WebSocket namespaces
for plugin in registry.plugins.values():
    plugin.register_ws_namespace(bus)
```

**Room Creation Hook** (in `rooms/services.py`):

```python
from ..plugins import registry

def create_room(room_id: str, room_type: str, creator: str):
    # ... existing room creation logic ...

    # Notify plugin
    plugin = registry.get_plugin_for_room_type(room_type)
    if plugin:
        plugin.on_room_created(room_id, room_type, creator)
```

### 4. Frontend Plugin System

**Location**: `frontend/src/plugins/`

**Plugin Loader** (`plugins/loader.js`):

```javascript
// Dynamically load and register frontend plugins
class PluginLoader {
    constructor() {
        this.plugins = new Map();
        this.roomTypeRenderers = new Map();
        this.wsNamespaceHandlers = new Map();
    }

    async registerPlugin(pluginConfig) {
        const { name, scripts, styles, config } = pluginConfig;

        // Load styles
        for (const styleUrl of styles) {
            await this.loadStylesheet(styleUrl);
        }

        // Load scripts
        for (const scriptUrl of scripts) {
            await this.loadScript(scriptUrl);
        }

        // Plugin should call pluginLoader.registerRoomType() when loaded
        this.plugins.set(name, config);
    }

    registerRoomType(roomType, renderer) {
        // renderer = { init, render, sendMessage, cleanup }
        this.roomTypeRenderers.set(roomType, renderer);
    }

    registerWSHandler(namespace, handler) {
        // handler = function(action, data)
        this.wsNamespaceHandlers.set(namespace, handler);
    }

    getRoomRenderer(roomType) {
        return this.roomTypeRenderers.get(roomType) || this.roomTypeRenderers.get('chat');
    }

    handleWSMessage(namespace, action, data) {
        const handler = this.wsNamespaceHandlers.get(namespace);
        if (handler) {
            handler(action, data);
        }
    }
}

export const pluginLoader = new PluginLoader();
```

**Modified Chat.js Dispatcher**:

```javascript
function dispatchMessage(data) {
    const type = data.type || '';
    const dotIdx = type.indexOf('.');
    if (dotIdx === -1) {
        console.warn('[WS] No namespace in type:', type);
        return;
    }

    const namespace = type.substring(0, dotIdx);
    const action = type.substring(dotIdx + 1);

    switch (namespace) {
        case 'system':
            handleSystemMessage(action, data);
            break;
        case 'room':
            handleRoomMessage(action, data);
            break;
        default:
            // Check if a plugin handles this namespace
            pluginLoader.handleWSMessage(namespace, action, data);
    }
}
```

**Plugin Initialization** (in `chat.js` startup):

```javascript
// Fetch plugin manifests from backend
async function initializePlugins() {
    const response = await fetch(`${API_URL}/plugins/manifest`);
    const plugins = await response.json();

    for (const plugin of plugins) {
        await pluginLoader.registerPlugin(plugin);
    }
}
```

### 5. Example Plugins

#### 5.1 Room Type Plugin: Whiteboard

**Backend** (`plugins/whiteboard_plugin.py`):

```python
class WhiteboardPlugin(Plugin):
    @property
    def name(self) -> str:
        return "whiteboard"

    @property
    def room_types(self) -> list[str]:
        return ["whiteboard"]

    def register_routes(self, app) -> APIRouter:
        router = APIRouter(prefix="/whiteboard", tags=["whiteboard"])

        @router.get("/rooms/{room_id}/canvas")
        async def get_canvas_state(room_id: str):
            # Return serialized canvas state
            pass

        @router.post("/rooms/{room_id}/canvas")
        async def save_canvas_state(room_id: str, state: dict):
            # Save canvas state
            pass

        return router

    def register_ws_namespace(self, bus: UnifiedConnectionManager):
        async def handle_whiteboard(bus, ws, username, msg):
            action = msg["type"].split(".", 1)[1]
            room_id = msg.get("room_id")

            if action == "draw":
                # Broadcast drawing data to all users in the room
                await bus.broadcast_to_room(room_id, {
                    "type": "whiteboard.draw",
                    "room_id": room_id,
                    "data": msg.get("data"),
                    "username": username
                })
            elif action == "clear":
                await bus.broadcast_to_room(room_id, {
                    "type": "whiteboard.clear",
                    "room_id": room_id,
                    "username": username
                })

        bus.register_namespace("whiteboard", handle_whiteboard)

    def get_frontend_assets(self) -> dict:
        return {
            "scripts": ["/static/plugins/whiteboard/whiteboard.js"],
            "styles": ["/static/plugins/whiteboard/whiteboard.css"],
            "config": {
                "tools": ["pen", "eraser", "line", "rectangle"]
            }
        }
```

**Frontend** (`frontend/public/plugins/whiteboard/whiteboard.js`):

```javascript
// This file is loaded dynamically when the whiteboard plugin is registered
(function() {
    const WhiteboardRenderer = {
        init: function(container, roomId) {
            const canvas = document.createElement('canvas');
            canvas.id = 'whiteboard-canvas';
            container.appendChild(canvas);

            // Initialize canvas, drawing tools, etc.
            this.setupDrawing(canvas, roomId);
        },

        render: function(data) {
            // Handle incoming draw commands
            this.drawOnCanvas(data);
        },

        sendMessage: function(drawData) {
            // Send draw commands via WebSocket
            ws.send(JSON.stringify({
                type: 'whiteboard.draw',
                room_id: currentRoom,
                data: drawData
            }));
        },

        cleanup: function() {
            // Clean up canvas, remove event listeners
        },

        setupDrawing: function(canvas, roomId) {
            // Canvas event listeners, drawing logic
        },

        drawOnCanvas: function(data) {
            // Render drawing commands from other users
        }
    };

    // Register the room type renderer
    window.pluginLoader.registerRoomType('whiteboard', WhiteboardRenderer);

    // Register WebSocket namespace handler
    window.pluginLoader.registerWSHandler('whiteboard', (action, data) => {
        switch (action) {
            case 'draw':
                WhiteboardRenderer.render(data.data);
                break;
            case 'clear':
                // Clear the canvas
                break;
        }
    });
})();
```

#### 5.2 Feature Plugin: Typing Indicators

**Backend** (`plugins/typing_plugin.py`):

```python
class TypingPlugin(Plugin):
    """Typing indicators - a feature that works across all room types."""

    @property
    def name(self) -> str:
        return "typing"

    # No room_types - this plugin doesn't create rooms, it enhances them

    def register_ws_namespace(self, bus: UnifiedConnectionManager):
        # Track who's typing in which room (ephemeral, no DB)
        # room_id -> {username: last_typing_time}
        typing_state = {}

        async def handle_typing(bus, ws, username, msg):
            action = msg["type"].split(".", 1)[1]
            room_id = msg.get("room_id")

            if action == "start":
                # User started typing
                if room_id not in typing_state:
                    typing_state[room_id] = {}
                typing_state[room_id][username] = time.time()

                # Broadcast to everyone else in the room
                await bus.broadcast_to_room(room_id, {
                    "type": "typing.user_typing",
                    "room_id": room_id,
                    "username": username,
                    "is_typing": True
                })

            elif action == "stop":
                # User stopped typing
                if room_id in typing_state:
                    typing_state[room_id].pop(username, None)

                await bus.broadcast_to_room(room_id, {
                    "type": "typing.user_typing",
                    "room_id": room_id,
                    "username": username,
                    "is_typing": False
                })

        bus.register_namespace("typing", handle_typing)

        # Also listen to room.message events to auto-clear typing state
        # This requires a hook mechanism for cross-namespace listening
        async def on_room_message(event):
            room_id = event.get("room_id")
            username = event["data"]["username"]
            if room_id in typing_state:
                typing_state[room_id].pop(username, None)
            await bus.broadcast_to_room(room_id, {
                "type": "typing.user_typing",
                "room_id": room_id,
                "username": username,
                "is_typing": False
            })

        # Register as listener for room.message events
        bus.on_event("room.message", on_room_message)

    def on_user_left_room(self, room_id: str, username: str):
        """Clean up typing state when user leaves."""
        # Would access typing_state here if it was instance variable
        pass

    def get_frontend_assets(self) -> dict:
        return {
            "scripts": ["/static/plugins/typing/typing.js"],
            "config": {
                "timeout_ms": 3000,  # Clear typing after 3s of inactivity
                "debounce_ms": 500   # Send typing events max every 500ms
            }
        }
```

**Frontend** (`frontend/public/plugins/typing/typing.js`):

```javascript
// Typing indicators plugin - works in all room types
(function() {
    let typingTimer = null;
    let lastTypingSent = 0;
    const DEBOUNCE_MS = 500;
    const TIMEOUT_MS = 3000;

    // Track who's typing in current room
    const typingUsers = new Set();

    // Hook into message input
    function initTypingIndicators() {
        const messageInput = document.getElementById('messageInput');
        if (!messageInput) return;

        messageInput.addEventListener('input', () => {
            const now = Date.now();
            if (now - lastTypingSent > DEBOUNCE_MS) {
                // Send typing.start
                ws.send(JSON.stringify({
                    type: 'typing.start',
                    room_id: currentRoom
                }));
                lastTypingSent = now;
            }

            // Reset stop timer
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'typing.stop',
                    room_id: currentRoom
                }));
            }, TIMEOUT_MS);
        });

        // Stop typing on blur or send
        messageInput.addEventListener('blur', stopTyping);
    }

    function stopTyping() {
        clearTimeout(typingTimer);
        if (currentRoom) {
            ws.send(JSON.stringify({
                type: 'typing.stop',
                room_id: currentRoom
            }));
        }
    }

    // Register WebSocket handler
    window.pluginLoader.registerWSHandler('typing', (action, data) => {
        if (action === 'user_typing' && data.room_id === currentRoom) {
            if (data.username === currentUsername) return; // Ignore self

            if (data.is_typing) {
                typingUsers.add(data.username);
            } else {
                typingUsers.delete(data.username);
            }

            updateTypingIndicator();
        }
    });

    function updateTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (!indicator) return;

        if (typingUsers.size === 0) {
            indicator.textContent = '';
            indicator.style.display = 'none';
        } else if (typingUsers.size === 1) {
            const user = Array.from(typingUsers)[0];
            indicator.textContent = `${user} is typing...`;
            indicator.style.display = 'block';
        } else if (typingUsers.size === 2) {
            const users = Array.from(typingUsers);
            indicator.textContent = `${users[0]} and ${users[1]} are typing...`;
            indicator.style.display = 'block';
        } else {
            indicator.textContent = `${typingUsers.size} people are typing...`;
            indicator.style.display = 'block';
        }
    }

    // Initialize when plugin loads
    window.addEventListener('DOMContentLoaded', initTypingIndicators);

    // Clean up when leaving a room
    window.addEventListener('room-changed', () => {
        typingUsers.clear();
        updateTypingIndicator();
    });
})();
```

**Key Points**:

- No `room_types` property - works in all rooms (channels, DMs, even whiteboard rooms)
- Ephemeral state (no database storage needed)
- Uses WebSocket namespace `typing.*` for bidirectional communication
- Listens to `room.message` events from the core to auto-clear typing state
- Frontend hooks into existing UI without creating new room renderers
- Debouncing and timeouts prevent spam

### 6. Frontend-Only Plugin Example

**Poll Plugin** (no backend, just UI):

```javascript
// frontend/public/plugins/polls/polls.js
(function() {
    const PollRenderer = {
        init: function(container, roomId) {
            // Polls are just specially formatted messages in chat
            // No special backend needed, just custom rendering
        },

        render: function(message) {
            // Check if message.content_type === 'poll'
            // Render poll UI with voting buttons
        },

        sendMessage: function(pollData) {
            // Send poll as a special content_type message
            ws.send(JSON.stringify({
                type: 'room.message',
                room_id: currentRoom,
                content: JSON.stringify(pollData),
                content_type: 'poll'
            }));
        }
    };

    // Register custom message renderer
    window.pluginLoader.registerContentTypeRenderer('poll', PollRenderer.render);
})();
```

### 7. Theme System

**Backend** (`/api/themes`):

```python
# New endpoint to serve available themes
@router.get("/themes")
async def list_themes():
    return {
        "themes": [
            {"id": "default", "name": "Default", "config": {...}},
            {"id": "dark", "name": "Dark Mode", "config": {...}},
            {"id": "high-contrast", "name": "High Contrast", "config": {...}}
        ]
    }

@router.get("/themes/{theme_id}")
async def get_theme(theme_id: str):
    # Return theme CSS variables and config
    return {
        "id": theme_id,
        "name": "Dark Mode",
        "css_variables": {
            "--background": "#1a1a1a",
            "--text": "#e0e0e0",
            "--primary": "#6366f1",
            # ... more variables
        },
        "config": {
            "message_density": "comfortable",
            "font_family": "system-ui"
        }
    }
```

**Frontend Theme Loader** (`utils.js`):

```javascript
export async function loadTheme(themeId) {
    const response = await fetch(`${API_URL}/themes/${themeId}`);
    const theme = await response.json();

    // Apply CSS variables to :root
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.css_variables)) {
        root.style.setProperty(key, value);
    }

    // Save preference
    localStorage.setItem('theme', themeId);
}

// Theme plugin structure
const themePlugin = {
    name: "theme-dark",
    css_variables: {...},
    message_renderer: function(message) {
        // Custom message rendering for this theme
    }
};
```

**Theme as Plugin**:

```javascript
// Themes can be plugins with custom CSS + JS behavior
window.pluginLoader.registerTheme({
    id: "discord-like",
    name: "Discord Style",
    cssUrl: "/static/themes/discord.css",
    config: {
        compact_messages: true,
        show_avatars: true
    }
});
```

## Implementation Phases

### Phase 1: Plugin Infrastructure (Backend)
- [ ] Create `plugins/` directory structure
- [ ] Implement `Plugin` base class and `PluginRegistry`
- [ ] Add `/api/plugins/manifest` endpoint
- [ ] Refactor existing chat into `ChatPlugin`
- [ ] Test plugin discovery and registration

### Phase 2: Plugin Infrastructure (Frontend)
- [ ] Create `PluginLoader` class
- [ ] Modify `dispatchMessage()` to support plugin namespaces
- [ ] Add room type renderer abstraction
- [ ] Implement plugin asset loading (JS/CSS)
- [ ] Test loading core chat plugin

### Phase 3: Example Full-Stack Plugin
- [ ] Build whiteboard plugin (backend + frontend)
- [ ] Add whiteboard room type to room creation UI
- [ ] Test WebSocket namespace isolation
- [ ] Document plugin development process

### Phase 4: Frontend-Only Plugin
- [ ] Build poll plugin (content_type renderer)
- [ ] Add content type plugin registration
- [ ] Test with existing chat backend
- [ ] Document frontend-only plugin pattern

### Phase 5: Theme System
- [ ] Create theme API endpoints
- [ ] Build theme loader and CSS variable system
- [ ] Create 2-3 example themes
- [ ] Add theme switcher to settings
- [ ] Support user preference persistence

### Phase 6: Plugin Marketplace (Future)
- [ ] Plugin upload/download
- [ ] Plugin sandboxing/permissions
- [ ] Plugin versioning and updates
- [ ] Plugin discovery UI

## API Changes

### New Endpoints

```
GET  /api/plugins/manifest          - List all registered plugins
GET  /api/plugins/{name}/config     - Get plugin configuration
GET  /api/themes                    - List available themes
GET  /api/themes/{id}               - Get theme details
POST /api/rooms (with room_type)    - Extended to support plugin room types
```

### Room Schema Changes

The `rooms` table already has a `room_type` column. Extend validation to allow plugin-provided room types:

```python
# Instead of hardcoded validation
if room_type not in ['channel', 'dm']:
    raise ValueError("Invalid room type")

# Use plugin registry
from ..plugins import registry
if room_type != 'dm' and not registry.get_plugin_for_room_type(room_type):
    raise ValueError(f"No plugin registered for room type: {room_type}")
```

## Security Considerations

1. **Plugin Sandboxing**: Plugins should not have direct database access (use services)
2. **WebSocket Namespace Isolation**: Ensure plugins can't hijack core namespaces
3. **Frontend Asset Validation**: Only load plugins from trusted sources
4. **Permission System**: Plugins may need permissions (e.g., "can modify canvas")
5. **Rate Limiting**: Apply to plugin endpoints to prevent abuse

## Developer Experience

### Creating a Plugin

1. Create backend plugin class:
   ```python
   from skrib.plugins import Plugin

   class MyPlugin(Plugin):
       # ... implement methods
   ```

2. Register in `main.py`:
   ```python
   from .plugins.my_plugin import MyPlugin
   registry.register(MyPlugin())
   ```

3. Create frontend plugin:
   ```javascript
   window.pluginLoader.registerRoomType('mytype', renderer);
   ```

4. Plugin is auto-discovered and loaded

### Plugin Documentation Template

```markdown
# My Plugin

## Installation
1. Copy `my_plugin.py` to `backend/skrib/plugins/`
2. Copy frontend assets to `frontend/public/plugins/my-plugin/`
3. Restart server

## Usage
Create room with type `mytype`

## WebSocket Events
- `mytype.action` - Description
- `mytype.update` - Description

## Configuration
...
```

## Comprehensive Plugin Examples

To validate the plugin architecture, here's an extensive list of potential plugins categorized by type:

### Room Type Plugins

| Plugin | Description | API Needs | WebSocket Namespace | State Storage | Special Requirements |
| --- | --- | --- | --- | --- | --- |
| **Whiteboard** | Collaborative drawing canvas | Canvas state CRUD | `whiteboard.*` | Canvas state per room | Real-time drawing sync |
| **Video Conference** | WebRTC video/audio rooms | Room session mgmt | `video.*` | Active sessions, recordings | WebRTC signaling server |
| **Code Editor** | Collaborative code editing | File/syntax API | `code.*` | Code documents, diffs | OT/CRDT for conflicts |
| **Kanban Board** | Task management boards | Cards/columns CRUD | `kanban.*` | Board state, cards | Drag-drop position sync |
| **Polls/Voting** | Live polls and voting | Poll CRUD, results | `poll.*` | Polls, votes | Anonymous voting option |
| **Mind Map** | Collaborative mind mapping | Node/edge CRUD | `mindmap.*` | Graph structure | Real-time node positions |
| **Spreadsheet** | Shared spreadsheet editor | Cell/formula API | `sheet.*` | Cell data, formulas | Formula evaluation |
| **Music Room** | Shared music listening party | Playback control | `music.*` | Queue, playback state | Spotify/YouTube API |
| **Game Room** | Multiplayer games (chess, etc.) | Game state API | `game.*` | Game state, moves | Game-specific rules engine |

### Feature Plugins (Work Across All Rooms)

| Plugin | Description | API Needs | WebSocket Namespace | State Storage | Events Listened |
| --- | --- | --- | --- | --- | --- |
| **Typing Indicators** | Show who's typing | None | `typing.*` | Ephemeral only | `room.message` |
| **Message Reactions** | Emoji reactions to messages | Reactions CRUD | `reaction.*` | Reactions per message | None |
| **Read Receipts** | Track who read messages | Receipt update | `receipt.*` | Last read per user/room | `room.message` |
| **Presence Status** | Online/away/busy status | Status update | `presence.*` | User status | `system.connected`, disconnect |
| **Message Translation** | Auto-translate messages | Translation API | `translate.*` | Language prefs | `room.message` |
| **Text Formatting** | Rich text (bold, italic, code) | None (client-side) | None | None | None |
| **Mention Autocomplete** | @username completion | User search | None | None | None |
| **Message Threading** | Reply threads to messages | Thread CRUD | `thread.*` | Thread relationships | `room.message` |
| **Voice Messages** | Record/send voice clips | Audio upload/stream | `voice.*` | Audio files | None |
| **Screen Sharing** | Share screen in any room | Session mgmt | `screenshare.*` | Active sessions | WebRTC signaling |
| **File Sharing** | Upload/download files | File CRUD, storage | `files.*` | File metadata, blobs | Virus scanning |
| **Link Previews** | Embed link previews | Metadata fetch | None (client) | Preview cache | `room.message` |
| **Code Syntax Highlight** | Highlight code blocks | None (client-side) | None | None | None |
| **Message Search** | Full-text search | Search API | None | Search index | `room.message` (indexing) |
| **Bookmarks/Pins** | Pin important messages | Bookmark CRUD | `bookmark.*` | Pins per user | None |
| **Custom Emojis** | Upload custom emoji | Emoji CRUD | None | Emoji images | None |
| **Giphy Integration** | Search/send GIFs | Giphy API proxy | None | None | None |
| **Message Editing History** | Track edit history | History API | None | Message versions | `room.message` |
| **Message Scheduling** | Schedule messages | Schedule CRUD | `schedule.*` | Scheduled messages | Cron/timer service |

### API Extension Plugins (Backend-Only)

| Plugin | Description | API Endpoints | WebSocket | State Storage | Purpose |
| --- | --- | --- | --- | --- | --- |
| **Analytics** | Usage analytics | `/analytics/*` stats APIs | None | Metrics, aggregates | Listen to all events |
| **Audit Log** | Complete audit trail | `/audit/*` query APIs | None | All events logged | Listen to all events |
| **Export/Import** | Data export (JSON/CSV) | `/export/*`, `/import/*` | None | Export jobs | Read all data |
| **Webhooks** | Outbound webhooks | `/webhooks/*` CRUD | None | Webhook configs | Listen to configured events |
| **REST API v2** | Extended API version | `/v2/*` | None | None | Alternative API design |
| **GraphQL** | GraphQL endpoint | `/graphql` | GraphQL subscriptions | None | Alternative query interface |
| **Backup/Restore** | Automated backups | `/backup/*` | None | Backup files | Database snapshots |
| **Rate Limiting** | API rate limits | None (middleware) | None | Rate counters | Intercept all requests |
| **User Directory** | LDAP/AD integration | `/directory/*` | None | User mapping | External auth sync |
| **SSO/SAML** | Enterprise SSO | `/sso/*` auth flow | None | SAML configs | Replace auth |

### Event Listener Plugins (Passive/Reactive)

| Plugin | Description | API Needs | Listens To | State Storage | Actions Taken |
| --- | --- | --- | --- | --- | --- |
| **Moderation Bot** | Auto-moderation | Ban/timeout API | `room.message` | Ban rules, history | Delete messages, ban users |
| **Notification Service** | External notifications | Config API | All user-scoped events | Notification prefs | Send email/push/SMS |
| **Logging Plugin** | Log to external service | None | All events | None | Forward to Splunk/ELK |
| **Welcome Bot** | Greet new users | None | `room.join` | None | Send welcome message |
| **Reminder Bot** | Set reminders | Reminder CRUD | `room.message` (commands) | Reminders | Send scheduled messages |
| **Activity Tracker** | Track user activity | None | `room.message`, `room.join` | Activity scores | Leaderboards |
| **Integration Bot** | Connect to Slack/Discord | Config API | `room.message` (commands) | Integration configs | Sync messages |
| **AI Assistant** | ChatGPT integration | None | `room.message` (mentions) | Conversation context | Reply with AI responses |
| **Metrics Collection** | Prometheus metrics | `/metrics` | All events | Metric counters | Export Prometheus format |
| **Security Scanner** | Scan for threats | Ban API | `room.message`, `files.*` | Threat signatures | Block/alert on threats |

### State Management Plugins (User-Specific Data)

| Plugin | Description | API Endpoints | WebSocket | State Storage | UI Integration |
| --- | --- | --- | --- | --- | --- |
| **Personal Notes** | Per-user notes | `/notes/*` CRUD | `notes.*` (sync) | Notes per user | Sidebar panel |
| **Message Bookmarks** | Save messages | `/bookmarks/*` CRUD | `bookmark.*` | Bookmark list per user | Starred icon, list view |
| **Custom Themes** | User theme prefs | `/themes/*` CRUD | None | Theme configs | Settings panel |
| **Keyboard Shortcuts** | Custom keybindings | `/shortcuts/*` CRUD | None | Keybind configs | Settings panel |
| **Notification Prefs** | Per-room notify prefs | `/prefs/*` | None | Prefs per user/room | Settings panel |
| **Drafts** | Auto-save drafts | `/drafts/*` CRUD | `draft.*` (sync) | Draft per room | Auto-restore on load |
| **Workspace State** | Save UI state | `/workspace/*` | None | Layout, sidebar state | Restore on login |
| **Quick Replies** | Canned responses | `/replies/*` CRUD | None | Reply templates | Insert menu |
| **Contact List** | Custom contact tags | `/contacts/*` CRUD | None | Tags, favorites | User profile enhancement |

### UI Enhancement Plugins (Frontend-Only)

| Plugin | Description | Assets | WebSocket | Hooks Into | Configuration |
| --- | --- | --- | --- | --- | --- |
| **Emoji Picker** | Enhanced emoji selector | JS, CSS | None | Message input | Emoji set selection |
| **Markdown Editor** | Live markdown preview | JS, CSS | None | Message input | Formatting toolbar |
| **Theme: Dark Mode** | Dark color scheme | CSS | None | Root CSS vars | Color customization |
| **Theme: Compact** | Dense UI layout | CSS | None | Message rendering | Density slider |
| **Vim Keybindings** | Vim-style navigation | JS | None | Key events | Mode indicator |
| **Unread Highlighter** | Visual unread indicator | CSS | None | Room list | Color/style options |
| **Avatar Frames** | Custom avatar borders | CSS | None | Avatar rendering | Frame selection |
| **Sound Effects** | Notification sounds | Audio files | Listen to all | Notification system | Sound pack selection |
| **Custom Fonts** | Load custom fonts | Font files, CSS | None | Typography | Font selection |
| **Accessibility** | Screen reader support | JS (ARIA) | None | All UI | Verbosity level |
| **Mobile Gestures** | Swipe navigation | JS | None | Touch events | Gesture customization |
| **Message Grouping** | Group consecutive msgs | CSS, JS | None | Message rendering | Time threshold |
| **Hover Cards** | User info on hover | JS, CSS | None | Username links | Card content selection |
| **Command Palette** | Cmd+K quick actions | JS, CSS | None | Key events | Command registration |

### Hybrid Plugins (Multiple Categories)

| Plugin | Categories | Description | Complexity |
| --- | --- | --- | --- |
| **End-to-End Encryption** | Feature + State | E2E encrypted messages with key management | High - requires key exchange, device management |
| **Calendar Integration** | Feature + API Extension | Schedule meetings, sync with Google Calendar | Medium - external API integration |
| **Jira Integration** | Event Listener + API Extension | Create tickets from messages, sync status | Medium - bidirectional sync |
| **Meeting Recorder** | Room Type + State | Record audio/video meetings with transcription | High - media processing, storage |
| **Q&A/Forum Mode** | Room Type + Feature | Stack Overflow-style Q&A with voting | Medium - voting, accepted answers |
| **Customer Support** | Room Type + Event Listener | Ticketing system with routing and SLAs | High - workflow management |
| **Live Streaming** | Room Type + Feature | Broadcast video to many viewers | High - video CDN, scaling |

### Plugin Interaction Patterns

Some plugins may need to interact with each other:

1. **Typing Indicators + Presence**: Show typing only if user is online
2. **Reactions + Notifications**: Don't notify for reactions from ignored users
3. **File Sharing + Virus Scanning**: Scan files before making available
4. **Message Search + Encryption**: Can't search encrypted message content
5. **Moderation + Audit Log**: Log all moderation actions
6. **Webhooks + Rate Limiting**: Rate limit webhook triggers
7. **AI Assistant + Moderation**: Filter AI responses for policy violations
8. **Translation + Encryption**: Translate before encrypting? After decrypting?

### Plugin Dependencies

Some plugins may depend on others:

- **Message Threading** depends on **Message Reactions** (for thread indicators)
- **Voice Messages** depends on **File Sharing** (for audio storage)
- **Screen Sharing** depends on **Video Conference** (for WebRTC)
- **Meeting Recorder** depends on **Video Conference** + **File Sharing**
- **Activity Tracker** depends on **Analytics** (for data collection)

## Architectural Requirements from Plugin List

Based on this comprehensive list, the plugin system needs:

### 1. Plugin Capability Declarations

Plugins should declare what they provide and require:

```python
class Plugin:
    @property
    def capabilities(self) -> list[str]:
        """Capabilities this plugin provides (e.g., 'file_storage', 'webrtc_signaling')."""
        return []

    @property
    def dependencies(self) -> list[str]:
        """Required capabilities from other plugins."""
        return []
```

### 2. Middleware/Interceptor Support

Some plugins (rate limiting, moderation) need to intercept requests:

```python
class Plugin:
    def register_middleware(self, app):
        """Register FastAPI middleware."""
        pass

    def intercept_message(self, message_data: dict) -> dict | None:
        """Modify or block a message before it's saved. Return None to block."""
        return message_data
```

### 3. External Service Integration

Many plugins need external APIs:

```python
class Plugin:
    @property
    def external_services(self) -> dict[str, str]:
        """External services used (e.g., {'giphy': 'https://api.giphy.com'})."""
        return {}

    @property
    def required_env_vars(self) -> list[str]:
        """Environment variables needed (e.g., ['GIPHY_API_KEY'])."""
        return []
```

### 4. Storage Patterns

Plugins need different storage approaches:

- **Ephemeral**: In-memory only (typing indicators, presence)
- **User-scoped**: Per-user data (bookmarks, preferences)
- **Room-scoped**: Per-room data (canvas state, board state)
- **Global**: System-wide (audit logs, analytics)
- **External**: Blob storage (files, recordings)

### 5. Lifecycle Management

Plugins need initialization and cleanup:

```python
class Plugin:
    async def on_startup(self):
        """Called when app starts."""
        pass

    async def on_shutdown(self):
        """Called when app stops (cleanup)."""
        pass

    async def on_enable(self):
        """Called when plugin is enabled (runtime)."""
        pass

    async def on_disable(self):
        """Called when plugin is disabled (cleanup state)."""
        pass
```

## Questions to Resolve

1. **Plugin Storage**: Should plugin data use the main database or separate storage?
2. **Plugin Updates**: How to handle schema migrations for plugins?
3. **Plugin Dependencies**: Can plugins depend on other plugins?
4. **Plugin Permissions**: Should there be a permission system for what plugins can access?
5. **Hot Reloading**: Should plugins support hot reload during development?

## Success Metrics

- Core chat functionality works as a plugin without regression
- Whiteboard plugin demonstrates full-stack plugin capability
- Theme system allows visual customization without code changes
- Plugin development guide is clear enough for external developers
- No performance degradation with multiple plugins loaded
