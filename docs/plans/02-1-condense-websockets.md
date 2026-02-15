# Plan 02.1

We need to condense all WebSocket traffic into a single connection per client, with a typed message bus for routing. This simplifies the architecture and allows for more flexible plugin development.

## Event Bus Strategy

The core idea is that **one WebSocket connection per client** carries all traffic, with **typed message multiplexing**. Rather than separate connections for chat, presence, notifications, etc., everything flows through a single pipe with a `type` field that routes it.

### Server-Side Bus

The server-side event bus is the central nervous system. The flow works like this:

A message arrives over WebSocket → the core server inspects the `type` field → it either handles it internally (auth, routing, system-level stuff) or dispatches it to the appropriate plugin subprocess via **JSON over stdin/stdout**. Plugins never touch the WebSocket directly. Core acts as gatekeeper — it enforces permissions, validates that a plugin is allowed to emit a given message type, and then relays the plugin's response back out over the WebSocket to the right recipients.

The plugin subprocess model means plugins are **isolated processes**. They register which event types they want to subscribe to (and which they're allowed to emit), and core manages that routing table. A misbehaving plugin can be killed without taking down the server.

### Client-Side Bus

On the client, incoming WebSocket messages hit a simple **dispatch/listener pattern** in JavaScript. The client maintains a registry of handlers keyed by message type. When a message arrives, it gets JSON-parsed, the `type` is read, and it's dispatched to all registered handlers for that type. This is how the UI stays decoupled — the chat panel listens for `message` types, the presence indicator listens for `presence` types, etc.

### Message Types

From our discussions, the message types break down roughly into these categories:

**Core/System types** (handled by core, never delegated to plugins): `auth`, `error`, `system` (server announcements, maintenance notices), `ping`/`pong` for keepalive.

**Chat types** (handled by the chat plugin): `message` (the standard chat message — text content plus metadata), `message_edit`, `message_delete`, `typing` indicators.

**Presence types**: `presence_update` (online/away/offline), `user_join`, `user_leave` for room-level presence.

**Room management types**: `room_create`, `room_join`, `room_leave`, `room_config` (settings changes), `room_invite`.

**Plugin-extensible types**: This is the open-ended part. When you add new room types (dashboards, todo boards, whiteboards), each plugin registers its own message types namespaced to avoid collisions — something like `todo.item_create`, `whiteboard.stroke`, `doc.operation`. Core doesn't need to understand these; it just routes them.

### Slash Commands as the Glue

Slash commands (`/kick`, `/invite`, `/topic`, etc.) arrive as regular `message` type payloads where the text starts with `/`. Core parses the command name, looks up which plugin registered that command, and dispatches it. The plugin processes it and can emit events back through the bus in response.

### Key Design Principle

The bus enforces a hard boundary: **core owns the transport and security layer, plugins own the semantics**. Core knows how to route a `todo.item_create` message to the todo plugin and relay the response to the right room members, but it has zero understanding of what a todo item actually is.

---

Want me to start turning any of this into actual Python code for the server-side bus, or the JS client-side dispatcher?
