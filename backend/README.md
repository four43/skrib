# API Structure Documentation

## Overview

The API has been reorganized following FastAPI best practices with feature-based modules. Each module contains its own routes, schemas, and business logic.

## Directory Structure

```text
backend/skrib/
├── __init__.py              # Package initialization
├── main.py                  # App initialization & router registration
├── config.py                # Configuration settings
├── database.py              # Database utilities & connection management
├── dependencies.py          # Shared dependencies (auth, etc.)
│
├── auth/                    # Authentication module
│   ├── __init__.py
│   ├── routes.py           # Auth endpoints
│   ├── schemas.py          # Pydantic models
│   └── services.py         # Business logic
│
├── subscriptions.py         # ListSubscriptionManager (WS push for list endpoints)
│
├── rooms/                   # Rooms module (channels + DMs)
│   ├── __init__.py
│   ├── routes.py           # Room endpoints + list subscription WS
│   ├── schemas.py          # Pydantic models (RoomInfo, DM requests)
│   ├── services.py         # Business logic (channels, DMs, validation)
│   └── websocket.py        # ConnectionManager for per-room chat WS
│
├── messages/                # Messages module
│   ├── __init__.py
│   ├── routes.py           # Message search endpoints
│   ├── schemas.py          # Pydantic models
│   └── services.py         # Business logic
│
├── admin/                   # Admin module
│   ├── __init__.py
│   ├── routes.py           # Admin endpoints
│   ├── schemas.py          # Pydantic models
│   └── services.py         # Business logic
│
├── admin_cli.py             # Admin CLI (uses API, not DB)
└── admin_cli_old.py         # Old CLI (deprecated)
```

## API Endpoints

### Authentication (`/api/auth`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/auth/register/begin` | Begin WebAuthn registration |
| POST | `/auth/register/complete` | Complete registration |
| GET | `/auth/login/begin` | Begin WebAuthn login |
| POST | `/auth/login/complete` | Complete login |
| GET | `/auth/session` | Check session validity |

### Rooms (`/api/rooms`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/rooms` | List rooms visible to user (channels + own DMs) |
| POST | `/rooms` | Create a room (supports plugin room types) |
| POST | `/rooms/dm` | Create or get a DM with another user |
| DELETE | `/rooms/{room_id}` | Soft-delete a room (admin only) |
| GET | `/rooms/{room_id}/messages` | Get messages in a room (supports `?since=id`) |
| POST | `/rooms/{room_id}/messages` | Send message to a room |

**Room Creation Body**:

```json
{
  "room_id": "general",           // For channels: lowercase + hyphens
  "room_type": "channel",         // "channel", "dm", or plugin-provided type
  "name": "General Discussion"    // Optional display name
}
```


### Users (`/api/users`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/users` | List all users (authenticated). Use `?status=pending` to filter by status |
| PATCH | `/users/pending/{approval_code}` | Approve or reject a pending user (admin only) |
| DELETE | `/users/{username}` | Delete a user (admin only) |
| PUT | `/users/{username}/role` | Set user role (admin only) |
| GET | `/users/preferences/colors` | All users' color preferences |
| GET | `/users/{username}/preferences` | Get user preferences |
| PUT | `/users/{username}/preferences` | Update user preferences |

### Messages (`/api/messages`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/messages` | Search messages globally |

**Query Parameters:**

- `query`: Search text in messages
- `room_id`: Filter by room
- `username`: Filter by user
- `limit`: Number of results (1-500, default 100)
- `offset`: Results to skip (for pagination)

### Plugins (`/api/plugins`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/plugins/manifest` | List all registered plugins with frontend assets |
| GET | `/plugins/{name}/config` | Get plugin-specific configuration |

**Manifest Response**:

```json
{
  "plugins": [
    {
      "name": "chat",
      "version": "1.0.0",
      "room_types": ["channel", "dm"],
      "scripts": ["/static/plugins/chat/chat.js"],
      "styles": ["/static/plugins/chat/chat.css"],
      "config": { "features": ["encryption", "typing_indicators"] }
    },
    {
      "name": "whiteboard",
      "version": "1.0.0",
      "room_types": ["whiteboard"],
      "scripts": ["/static/plugins/whiteboard/whiteboard.js"],
      "styles": ["/static/plugins/whiteboard/whiteboard.css"],
      "config": { "tools": ["pen", "eraser", "line"] }
    }
  ]
}
```

### Themes (`/api/themes`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/themes` | List available themes |
| GET | `/themes/{theme_id}` | Get theme CSS variables and config |

**Theme Response**:

```json
{
  "id": "dark",
  "name": "Dark Mode",
  "css_variables": {
    "--background": "#1a1a1a",
    "--text": "#e0e0e0",
    "--primary": "#6366f1"
  },
  "config": {
    "message_density": "comfortable",
    "font_family": "system-ui"
  }
}
```

## WebSocket Protocol

### Connection

**Endpoint**: `WS /api/ws?token={sessionToken}`

- Single persistent connection per client
- Authentication via query parameter
- Namespace-based message routing (extensible via plugins)

### Message Format

All WebSocket messages follow the format:
```json
{
  "type": "namespace.action",
  "room_id": "...",     // Optional, depends on action
  "...": "..."          // Additional fields per action
}
```

### Namespaces

The WebSocket bus uses **namespaces** to route messages. Core namespaces:

- `system.*` - Connection-level events (authentication, ping/pong, errors)
- `room.*` - Room-related events (join, leave, messages, topic)
- **Plugin namespaces** - Plugins can register custom namespaces (e.g., `whiteboard.*`, `polls.*`)

### Client → Server Events

#### System Namespace (Client → Server)

```javascript
// Ping server
{ "type": "system.ping" }
```

#### Room Namespace (Client → Server)

```javascript
// Join a room (subscribe to room-scoped broadcasts)
{
  "type": "room.join",
  "room_id": "general"
}

// Leave a room (unsubscribe from room-scoped broadcasts)
{
  "type": "room.leave",
  "room_id": "general"
}

// Send a message
{
  "type": "room.message",
  "room_id": "general",
  "content": "Hello world",
  "content_type": "text",        // Optional: "text", "encrypted", "poll", etc.
  "key_epoch": 1                 // Optional: for E2E encryption
}
```

#### Plugin Namespaces (Client → Server)

```javascript
// Whiteboard plugin: send drawing data
{
  "type": "whiteboard.draw",
  "room_id": "design-room",
  "data": {
    "x": 100,
    "y": 200,
    "color": "#ff0000",
    "tool": "pen"
  }
}
```

### Server → Client Events

#### System Namespace (Server → Client)

```javascript
// Connection established
{ "type": "system.connected", "username": "alice" }

// Pong response
{ "type": "system.pong" }

// Error
{ "type": "system.error", "message": "Invalid JSON" }
```

#### Room Namespace (Server → Client)

**Room-scoped events** (sent only to sockets that sent `room.join`):

```javascript
// Join confirmation
{ "type": "room.joined", "room_id": "general" }

// Leave confirmation
{ "type": "room.left", "room_id": "general" }

// New message in the room
{
  "type": "room.message",
  "room_id": "general",
  "data": {
    "id": 123,
    "username": "bob",
    "content": "Hello",
    "content_type": "text",
    "timestamp": "2026-02-15T10:30:00Z",
    "key_epoch": null
  }
}

// Topic changed
{
  "type": "room.topic",
  "room_id": "general",
  "topic": "New topic",
  "set_by": "alice"
}

// Error in room action
{
  "type": "room.error",
  "room_id": "general",
  "message": "Not a member of this DM"
}
```

**User-scoped events** (sent to all of a user's connected tabs):

```javascript
// Room list changed (new room, deleted room, membership change)
{
  "type": "room.update",
  "room_id": "general",
  "room_type": "channel",
  "sender": "alice",
  "unread_count": 5
}

// New message notification (for users with notify_level='all')
{
  "type": "room.new_message",
  "room_id": "general",
  "room_type": "channel",
  "sender": "bob",
  "unread_count": 6
}
```

#### Plugin Namespaces (Server → Client)

```javascript
// Whiteboard plugin: broadcast drawing data
{
  "type": "whiteboard.draw",
  "room_id": "design-room",
  "data": { "x": 100, "y": 200, "color": "#ff0000" },
  "username": "alice"
}

// Whiteboard plugin: canvas cleared
{
  "type": "whiteboard.clear",
  "room_id": "design-room",
  "username": "bob"
}
```

### Event Scopes

The WebSocket bus supports two broadcast scopes:

1. **Room-scoped**: Only sent to sockets that explicitly joined the room via `room.join`
   - Examples: `room.message`, `room.topic`, `whiteboard.draw`
   - Use: Real-time collaboration within a specific room

2. **User-scoped**: Sent to all of a user's connected tabs/devices
   - Examples: `room.update`, `room.new_message`
   - Use: Notifications, sidebar updates, global state sync

### Namespace Registration (Plugin Development)

Plugins register custom namespaces via:

```python
def register_ws_namespace(self, bus: UnifiedConnectionManager):
    async def handle_my_namespace(bus, ws, username, msg):
        action = msg["type"].split(".", 1)[1]
        room_id = msg.get("room_id")

        if action == "custom_action":
            await bus.broadcast_to_room(room_id, {
                "type": "myplugin.custom_action",
                "room_id": room_id,
                "data": msg.get("data")
            })

    bus.register_namespace("myplugin", handle_my_namespace)
```

Frontend plugins register handlers via:

```javascript
window.pluginLoader.registerWSHandler('myplugin', (action, data) => {
    if (action === 'custom_action') {
        // Handle the event
    }
});
```

## Design Principles

### 1. Resource-Based URLs

- Uses plural nouns: `/rooms`, `/messages`, `/users`
- HTTP methods indicate actions (GET, POST, DELETE)
- Nested resources: `/rooms/{room_id}/messages`

### 2. Feature-Based Modules

- Each domain (auth, rooms, messages, admin) has its own module
- Separates routes, schemas, and services
- Better for monolithic apps with multiple domains

### 3. Separation of Concerns

- **Routes**: Handle HTTP requests/responses
- **Schemas**: Pydantic models for validation
- **Services**: Business logic & database operations
- **Database**: Connection management & utilities
- **Dependencies**: Shared auth & middleware

### 4. API-First Admin CLI

- CLI uses HTTP API instead of direct database access
- Follows best practice of treating CLI as an API client
- Easier to extend and maintain
- Can be used remotely with `--url` flag

## Running the Application

### Start the server

```bash
cd backend
python -m uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000
```

### Use the Admin CLI

```bash
# Interactive mode
python skrib/admin_cli.py

# Direct commands
python skrib/admin_cli.py list
python skrib/admin_cli.py approve ABC123DEF456
python skrib/admin_cli.py set-admin alice
python skrib/admin_cli.py status

# Remote API
python skrib/admin_cli.py --url http://remote-server:8000 status
```

## Migration Notes

### Old Structure → New Structure

| Old | New |
| --- | --- |
| `chat_server_webauthn.py` | Split into modules |
| Direct DB access in CLI | API-based CLI |
| Single routes file | Feature-based routers |
| Mixed concerns | Separated layers |

### Backward Compatibility

The API endpoints remain the same, just reorganized internally:

- `/api/register/*` → `/api/auth/register/*`
- `/api/login/*` → `/api/auth/login/*`
- `/api/rooms` stays the same
- `/api/create_room` → `/api/rooms` (POST)
- `/api/send_message` → `/api/rooms/{room_id}/messages` (POST)
- `/api/messages` → `/api/messages` (with query params)

## Benefits

1. **Scalability**: Easy to add new features/modules
2. **Maintainability**: Clear separation of concerns
3. **Testability**: Each module can be tested independently
4. **Collaboration**: Teams can work on different modules
5. **API Documentation**: Auto-generated with FastAPI
6. **Type Safety**: Pydantic schemas throughout
