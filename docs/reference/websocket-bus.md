# WebSocket Bus

Skrib uses a single WebSocket connection per client, multiplexed across namespaces. All real-time communication — room messages, typing indicators, reactions, system events — flows through this unified bus.

## Connection

```
WS /api/ws?token={sessionToken}
```

One connection per browser tab. A user with multiple tabs open has multiple WebSocket connections, all tracked by the connection manager.

## Message Format

All WebSocket messages are JSON with a `type` field in `namespace:action` format:

```json
{
  "type": "room:message",
  "room_id": "abc123",
  "content": "{encrypted envelope}"
}
```

## Namespaces

| Namespace | Owner | Description |
|---|---|---|
| `system` | Core | Connection lifecycle (ping, pong, connected, error) |
| `room` | Core + plugins | Room operations (join, leave, then delegated to room-type plugin) |
| `{plugin-id}` | Plugin | Plugin-specific events (e.g., `four43.chat-typing:start`) |

### Routing

When a message arrives:

1. Parse `type` as `namespace:action`
2. If `system:*` — handled by core (ping/pong, connection management)
3. If `room:join` or `room:leave` — handled by core (subscription management)
4. If `room:*` (other actions) — look up the room's type, resolve its owning
   plugin via `bridge.get_bus_plugin_for_room_type(room_type)` — which checks
   in-process plugins first, then the bus server's `room_type_map` — and
   dispatch through `bridge.dispatch_room_action(...)`. `ws/handlers.py` is
   runtime-agnostic: it calls the same two methods either way and never
   branches on where the plugin actually runs.
5. If `{plugin-id}:*` — route to the matching bus-connected feature plugin via `_dispatch_plugin_namespace` in `ws/manager.py`, which applies the same membership checks as `handle_room`.

A plugin's `runtime` manifest key selects where it runs: `"in_process"`
plugins are loaded and hosted inside the backend by `InProcessHost`;
`"process"` — the default when `runtime` is absent — runs the plugin as a
standalone process that connects here over the bus. `four43.room-type-chat` is
the one `runtime: "in_process"` plugin today; the rest are `"process"`.

> **Changing.** `docs/spec/2026-08-02-core-log-and-signal.md` moves message
> persistence into core, so `room:message` will no longer be a plugin
> round-trip at all, for either runtime.

## Connection Manager

The `UnifiedConnectionManager` (`backend/skrib/ws/manager.py`) tracks:

### Data Structures

```python
user_connections: dict[str, set[WebSocket]]
# username -> all of that user's open WebSocket connections (across tabs)

room_subscriptions: dict[str, set[WebSocket]]
# room_id -> WebSocket connections that have sent room:join for that room
```

### Scoping

| Scope | Method | Recipients | Use Case |
|---|---|---|---|
| User-scoped | `notify_user(username, message)` | All tabs for that user | Room list updates, unread counts, room metadata changes |
| Room-scoped | `broadcast_to_room(room_id, message)` | Only tabs subscribed to that room | Messages, typing indicators, topic changes |
| Single socket | Direct `ws.send_json()` | One specific tab | Error responses, join confirmations |

### Room Join/Leave

When a user switches rooms in the UI:

1. Client sends `{"type": "room:leave", "room_id": "old-room"}`
2. Client sends `{"type": "room:join", "room_id": "new-room"}`
3. No WebSocket teardown — the same connection is reused

This allows a single connection to participate in one room at a time per tab, while the user receives notifications for all their rooms across all tabs.

## Event System

The WebSocket manager includes an internal event system for cross-namespace communication:

| Method | Description |
|---|---|
| `emit_event(event, data)` | Fire a lifecycle event (e.g., `core:room_created`) |
| `on_event(event, callback)` | Register a listener for an event |
| `off_event(event, callback)` | Remove an event listener |
| `register_reply_to(ws)` | Create an opaque token for plugin error responses back to the originating socket |

Plugins use this to observe core events. Note that the coupling is not as loose as
it looks: the Web Push plugin subscribes to `four43.room-type-chat:message` **by
name** (`plugins/four43.web-push/backend/plugin_bus.py:18`), so push notifications
only work for one room type. Once core owns the item log
(`docs/spec/2026-08-02-core-log-and-signal.md`), it subscribes to core log items
instead and works for every room type.

Also note that plugin `subscriptions` are declared as Python class attributes, not
in the manifest, so an approving admin cannot see what a plugin listens to. That
moves into the manifest per `docs/spec/2026-08-02-extension-model.md` §1.

## Client-Side Implementation

Located in `frontend/src/app.js` (lines 1642-1764).

### Reconnection

- Exponential backoff: up to 10 attempts
- Delays: 1 second initial, increasing to 10 seconds max
- On `visibilitychange`: if a backgrounded tab becomes visible again, reconnect immediately (mobile browsers often kill idle WebSocket connections)
- On reconnect: reloads room keys and re-joins the current room

### Handler Registration

Plugins register WebSocket message handlers via the plugin context:

```javascript
context.registerHandler("four43.room-type-chat:message", (data) => {
  // Handle incoming chat message
});
```

Core handlers are registered directly in `app.js` for events like `room:update`, `room:new_message`, `room:deleted`.

## Events Reference

### Core Events

| Event | Direction | Scope | Description |
|---|---|---|---|
| `system:connected` | Server -> Client | Single socket | Connection established, includes user info |
| `system:ping` / `system:pong` | Bidirectional | Single socket | Keep-alive |
| `system:error` | Server -> Client | Single socket | Error response |
| `room:join` | Client -> Server | — | Subscribe to room events |
| `room:leave` | Client -> Server | — | Unsubscribe from room events |
| `room:update` | Server -> Client | User-scoped | Room metadata changed (topic, settings) |
| `room:new_message` | Server -> Client | User-scoped | Notification that a room has a new message (for unread badges) |
| `room:deleted` | Server -> Client | User-scoped | Room was deleted |
| `room:folders_updated` | Server -> Client | User-scoped | Room folder structure changed |
| `room:join_request` | Server -> Client | User-scoped (to room ops) | New join request submitted for a public room |
| `room:join_resolved` | Server -> Client | User-scoped (to requester) | Join request approved or denied |
| `room:visibility_changed` | Server -> Client | User-scoped (to room members) | Room visibility toggled between public/private |

### Chat Plugin Events (`four43.room-type-chat`)

| Event | Direction | Scope |
|---|---|---|
| `room:message` | Client -> Server | — (action delegated to plugin) |
| `four43.room-type-chat:message` | Server -> Client | Room-scoped |
| `room:edit_message` | Client -> Server | — |
| `four43.room-type-chat:edit_message` | Server -> Client | Room-scoped |
| `room:delete_message` | Client -> Server | — |
| `four43.room-type-chat:delete_message` | Server -> Client | Room-scoped |

### Typing Plugin Events (`four43.chat-typing`)

| Event | Direction | Scope |
|---|---|---|
| `four43.chat-typing:start` | Bidirectional | Room-scoped |
| `four43.chat-typing:stop` | Bidirectional | Room-scoped |

### Reaction Plugin Events (`four43.message-reactions`)

| Event | Direction | Scope |
|---|---|---|
| `four43.message-reactions:add` | Client -> Server | — |
| `four43.message-reactions:remove` | Client -> Server | — |
| `four43.message-reactions:update` | Server -> Client | Room-scoped |

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/ws/manager.py` | UnifiedConnectionManager (connections, subscriptions, broadcasting) |
| `backend/skrib/ws/handlers.py` | Core message handlers (join, leave, routing) |
| `backend/skrib/ws/routes.py` | WebSocket endpoint (`/api/ws`) |
| `frontend/src/app.js` | Client-side WebSocket management, reconnection, handler dispatch |
