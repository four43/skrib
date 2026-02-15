# Plan 07: Extend WebSocket Protocol with Event Types

## Goal

Evolve the WebSocket protocol to support structured event types beyond just chat messages. This enables join/part/kick/topic notifications in real-time, system messages stored server-side, and a foundation for bot extensibility.

**Depends on:** Plan 03 (content types) should be implemented first so `content_type` is available.

Don't worry about schema migration. We can delete and recreate the database during development.

## Protocol Changes

### Client → Server (commands)

**Current:**
```json
{"type": "message", "message": "hello"}
```

**New:**
```json
{"cmd": "message", "content": "hello", "content_type": "text"}
{"cmd": "message", "content": "base64...", "content_type": "encrypted", "key_epoch": 3}
{"cmd": "topic", "content": "New channel topic"}
{"cmd": "typing"}
```

Changes:
- `type` → `cmd` (distinguishes client commands from server events)
- `message` → `content` (aligns with Plan 03 column rename)
- Add `content_type` and `key_epoch` fields
- New command types: `topic`, `typing`

### Server → Client (events)

**Current:**
```json
{"type": "connected", "room": "general", "username": "alice"}
{"type": "message", "data": {"id": 1, "username": "alice", "message": "hello", "timestamp": "..."}}
{"type": "error", "message": "Invalid JSON"}
```

**New:**
```json
{"event": "connected", "data": {"room": "general", "username": "alice"}}
{"event": "message", "data": {"id": 1, "sender": "alice", "content": "hello", "content_type": "text", "timestamp": "..."}}
{"event": "join", "data": {"username": "bob", "timestamp": "..."}}
{"event": "part", "data": {"username": "bob", "timestamp": "..."}}
{"event": "kick", "data": {"username": "bob", "kicked_by": "alice", "timestamp": "..."}}
{"event": "topic", "data": {"topic": "New topic", "set_by": "alice", "timestamp": "..."}}
{"event": "typing", "data": {"username": "alice"}}
{"event": "error", "data": {"message": "Invalid JSON"}}
```

Changes:
- `type` → `event` (consistent naming)
- `data.username` → `data.sender` for messages (avoids ambiguity with join/part)
- `data.message` → `data.content` (aligns with Plan 03)
- New event types: `join`, `part`, `kick`, `topic`, `typing`
- `connected` and `error` now use `data` wrapper for consistency

### Backward Compatibility

During transition, the server should accept both old and new formats:
- Accept `type` or `cmd` as the command key
- Accept `message` or `content` as the content key
- Server always sends new format (frontend is deployed together)

## Event Generation

Events are generated when membership or room state changes. These events are:
1. Broadcast via WebSocket to connected room clients
2. Stored as `content_type='system'` messages in the database (for history)

### Join event
**Trigger:** `POST /rooms/{id}/invite` or `POST /rooms/{id}/join` succeeds
**Actions:**
- Broadcast `{"event": "join", "data": {"username": "bob", ...}}` to room WS
- Insert system message: `"bob joined the channel"` with `content_type='system'`

### Part event
**Trigger:** `POST /rooms/{id}/part` succeeds
**Actions:**
- Broadcast `{"event": "part", ...}` to room WS
- Insert system message: `"bob left the channel"` with `content_type='system'`

### Kick event
**Trigger:** `POST /rooms/{id}/kick/{user}` succeeds
**Actions:**
- Broadcast `{"event": "kick", ...}` to room WS
- Insert system message: `"alice kicked bob"` with `content_type='system'`

### Topic event
**Trigger:** `PUT /rooms/{id}/topic` succeeds, or `cmd: "topic"` via WS
**Actions:**
- Broadcast `{"event": "topic", ...}` to room WS
- Insert system message: `"alice changed the topic to: New topic"` with `content_type='system'`

## Files to Change

### `backend/mini_chat/rooms/message_routes.py` (or routes.py pre-split)

**WebSocket handler rewrite:**

```python
async def websocket_endpoint(websocket, room_id, token):
    # ... auth as before ...

    while True:
        data = await websocket.receive_text()
        payload = json.loads(data)

        # Accept both old and new format
        cmd = payload.get("cmd") or payload.get("type")
        content = payload.get("content") or payload.get("message", "")

        if cmd == "message":
            content_type = payload.get("content_type", "text")
            key_epoch = payload.get("key_epoch")
            room = ChatRoom(room_id)
            message = room.add_message(
                username, content,
                content_type=content_type,
                key_epoch=key_epoch
            )
            await manager.broadcast_to_room(room_id, {
                "event": "message",
                "data": {
                    "id": message["id"],
                    "sender": username,
                    "content": message["content"],
                    "content_type": message["content_type"],
                    "key_epoch": message.get("key_epoch"),
                    "timestamp": message["timestamp"],
                }
            })

        elif cmd == "topic":
            # Set topic via WS (alternative to REST endpoint)
            set_topic(room_id, content, username)
            await manager.broadcast_to_room(room_id, {
                "event": "topic",
                "data": {"topic": content, "set_by": username, "timestamp": now()}
            })

        elif cmd == "typing":
            # Broadcast typing indicator (don't store)
            await manager.broadcast_to_room(room_id, {
                "event": "typing",
                "data": {"username": username}
            }, exclude=websocket)
```

### `backend/mini_chat/rooms/membership_routes.py` (or routes.py pre-split)

After invite/part/kick succeeds, broadcast event to room:

```python
# In invite endpoint, after successful add:
await manager.broadcast_to_room(room_id, {
    "event": "join",
    "data": {"username": target_username, "timestamp": now()}
})
# Store system message
ChatRoom(room_id).add_message("system", f"{target_username} joined the channel", content_type="system")

# In part endpoint:
await manager.broadcast_to_room(room_id, {
    "event": "part",
    "data": {"username": username, "timestamp": now()}
})
ChatRoom(room_id).add_message("system", f"{username} left the channel", content_type="system")

# In kick endpoint:
await manager.broadcast_to_room(room_id, {
    "event": "kick",
    "data": {"username": target, "kicked_by": username, "timestamp": now()}
})
ChatRoom(room_id).add_message("system", f"{username} kicked {target}", content_type="system")
```

### `backend/mini_chat/rooms/websocket.py`

Add `broadcast_to_room` optional `exclude` parameter for typing events (don't echo typing back to sender):

```python
async def broadcast_to_room(self, room_id, message, exclude=None):
    for ws in self.active_connections.get(room_id, set()):
        if ws != exclude:
            await ws.send_json(message)
```

### Frontend: `frontend/src/chat.js`

**`sendMessage()`:**
```javascript
websocket.send(JSON.stringify({
    cmd: 'message',
    content: payload,
    content_type: encrypted ? 'encrypted' : 'text',
    key_epoch: encrypted ? latestEpoch : undefined,
}));
```

**`handleWebSocketMessage()`:**
```javascript
function handleWebSocketMessage(data) {
    const event = data.event || data.type;  // backward compat
    switch (event) {
        case 'connected':
            break;
        case 'message':
            displayMessage(data.data);
            break;
        case 'join':
            displaySystemMessage(`${data.data.username} joined the channel`);
            break;
        case 'part':
            displaySystemMessage(`${data.data.username} left the channel`);
            break;
        case 'kick':
            displaySystemMessage(`${data.data.kicked_by} kicked ${data.data.username}`);
            break;
        case 'topic':
            displaySystemMessage(`${data.data.set_by} changed the topic to: ${data.data.topic}`);
            updateTopicDisplay(data.data.topic);
            break;
        case 'typing':
            showTypingIndicator(data.data.username);
            break;
        case 'error':
            console.error('[WS] Server error:', data.data?.message || data.message);
            break;
    }
}
```

**`displayMessage()`:**
Update to use `msg.content` instead of `msg.message`, and `msg.sender` instead of `msg.username`. Handle `content_type='system'` messages with system styling.

**New: typing indicator support (basic):**
```javascript
let typingTimeout = null;

function showTypingIndicator(username) {
    const indicator = document.getElementById('typingIndicator');
    indicator.textContent = `${getDisplayName(username)} is typing...`;
    indicator.classList.add('visible');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => indicator.classList.remove('visible'), 3000);
}

// Send typing event on input (debounced)
let lastTypingSent = 0;
messageInput.addEventListener('input', () => {
    if (Date.now() - lastTypingSent > 2000 && websocket?.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ cmd: 'typing' }));
        lastTypingSent = Date.now();
    }
});
```

### Frontend: `frontend/chat.html`
- Add typing indicator element: `<div id="typingIndicator" class="typing-indicator"></div>`
- Place it between messages area and input area

### Frontend: `frontend/src/style.css`
- Add `.typing-indicator` styles

## Bot Extensibility

This protocol design is bot-friendly:
- Bots connect via the same WebSocket endpoint with a token
- Bots receive all `event` types (message, join, part, topic, etc.)
- Bots send `cmd` messages just like regular users
- New event/command types can be added without changing the protocol structure
- Bots can respond to join events (welcome messages), topic changes, etc.

## Testing Checklist

- [ ] Old format `{type: "message", message: "..."}` still works (backward compat)
- [ ] New format `{cmd: "message", content: "..."}` works
- [ ] Encrypted messages include `content_type` and `key_epoch`
- [ ] Join event broadcast when user invited
- [ ] Part event broadcast when user leaves
- [ ] Kick event broadcast when user kicked
- [ ] Topic event broadcast when topic changed
- [ ] System messages stored in DB with `content_type='system'`
- [ ] System messages display with distinct styling
- [ ] Typing indicator shows and auto-hides
- [ ] Typing events not echoed back to sender
