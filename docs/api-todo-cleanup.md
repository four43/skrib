# API & Plugin System Cleanup TODO

## High Severity

### 1. WebSocket namespace separator: `:` vs `.`

Code uses **colons** (`system:connected`, `room:message`) but README.md documents **dots** (`system.ping`, `room.join`). The dispatcher in `ws/manager.py:157` splits on `:`, so the docs are wrong. This will confuse anyone building plugins from the docs.

### 2. Error response formats are inconsistent

- HTTP errors use `detail` (via FastAPI's `HTTPException`) - consistent
- WebSocket errors use `message` field - consistent within WS
- But **plugin HTTP responses** mix patterns: reactions returns `{"success": True}` for deletes but `{"message_id": ..., "emoji": ...}` (no status field) for adds

### 3. Plugin `name` vs plugin `id` mismatch

- `four43.room-type-chat` plugin returns `name = "room-type-chat"` (different from its ID)
- `four43.chat-typing` returns `name = "four43.chat-typing"` (matches its ID)

## Medium Severity

### 4. List response wrapping is inconsistent

- Users/Rooms: wrapped in `{ "users": [...] }` / `{ "rooms": [...] }`
- Themes/Plugins: return bare `List[...]` with no wrapper

### 5. Plugin WebSocket namespacing

- Chat plugin uses core namespace: `room:message`, `room:edit_message`
- Typing plugin uses its own namespace: `four43.chat-typing:user_typing`
- Reactions plugin has **no WebSocket events at all** (HTTP only)
- Todo plugin uses core namespace: `room:todo_added` (collision risk)

Plugins that aren't "room type" plugins should use their own namespace (`{plugin.id}:action`) to avoid collisions.

### 6. Duplicated permission logic

The todo plugin reimplements `_can_edit()` with its own room role + global role checks instead of using a shared helper from `rooms/services.py`.
For
### 7. Plugin route prefix patterns

- Chat plugin defines absolute paths: `/rooms/{room_id}/messages`
- Reactions plugin uses relative prefix: `/reactions`
- Web-push uses relative prefix: `/subscriptions`

Since plugins mount at `/api/plugins/{plugin.id}/`, the absolute-path approach in the chat plugin is odd.

## Low Severity

### 8. Auth dependency naming

Routes use `username`, `admin`, or `_` inconsistently for the auth dependency variable name. Minor, but `_` on `users/routes.py:60` hides that auth is happening.

### 9. camelCase in auth schemas

Fields like `rpId`, `credentialId`, `allowCredentials` are camelCase because they match the WebAuthn JS API. This is a reasonable exception but worth documenting explicitly.

### 10. No transaction safety for multi-step operations

Creating a room and adding the creator as a member happen in separate commits - if the second fails, you get an orphaned room.

## Recommended Fix Order

1. **Fix the README** - update namespace examples from `.` to `:` so they match the actual code
2. **Standardize plugin names** to match their IDs
3. **Centralize permission checking** into a shared service function
4. **Pick a convention for plugin WS namespacing** - room-type plugins use `room:*`, everything else uses `{plugin.id}:*`
5. **Wrap all list responses consistently** (either always wrap or never wrap)
