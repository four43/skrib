# four43.chat-typing — Typing Indicators

Real-time typing indicators showing who's typing in chat rooms.

## Plugin Type

Feature plugin (no room type, no database). Purely ephemeral WebSocket events.

## Structure

```
backend/plugin.py       # ChatTypingPlugin — in-memory typing state, WS handler
frontend/plugin.js      # TypingPlugin IIFE — input listeners, indicator UI
manifest.json           # Permissions: bus.send, bus.receive, dom.input, dom.message-area
```

## How It Works

- **Backend**: Tracks `typing_state` dict (`room_id -> {username: timestamp}`) in memory. Registers a WS handler for the `four43.chat-typing:*` namespace. On `start`/`stop` actions, broadcasts `user_typing` events to other users in the room via `bus.broadcast_to_room()`.
- **Frontend**: Uses a MutationObserver to detect when `#message-input` appears/disappears (since room-type plugins create it dynamically). Attaches `input`/`blur` listeners. Sends `four43.chat-typing:start` on input (debounced 500ms) and `four43.chat-typing:stop` after 3s idle or blur. Displays a typing indicator div above the input area.
- **No database**: All state is ephemeral. No `get_table_schema()`.

## WebSocket Events

| Direction | Type | Payload |
|-----------|------|---------|
| Client -> Server | `four43.chat-typing:start` | `{room_id}` |
| Client -> Server | `four43.chat-typing:stop` | `{room_id}` |
| Server -> Client | `four43.chat-typing:user_typing` | `{room_id, username, is_typing}` |

## Key Details

- Hooks: `onRoomChange` — clears typing users and stops own typing on room switch
- Frontend exports as `window["Four43.chat-typingPlugin"]`
- No HTTP routes
