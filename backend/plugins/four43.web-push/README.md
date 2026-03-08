# four43.web-push — Web Push Notifications

Sends Web Push notifications for new chat messages when the user has no active WebSocket connection.

## Plugin Type

Feature plugin (no room type). Has its own plugin-scoped SQLite database. Uses `core_api` to check connection status and room membership.

## Structure

```
backend/
  plugin.py             # WebPushPlugin — startup, event listener, push delivery logic
  routes.py             # HTTP endpoints: VAPID key, subscribe, unsubscribe
  services.py           # VAPID key management, subscription CRUD, pywebpush sending
frontend/
  src/plugin.js         # WebPushPlugin IIFE source — permission request, Push API subscription
  vite.config.js        # Vite lib mode build config (IIFE → dist/plugin.js)
  package.json          # Build deps (vite) + build/watch scripts
  dist/plugin.js        # Built output (gitignored)
manifest.json           # Permissions: bus.receive, http.routes, storage.read/write, core_api
```

## Database Schema

Plugin-scoped DB. Two tables:

```sql
push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
-- Index: idx_push_subs_username ON push_subscriptions(username)

vapid_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL
)
```

## HTTP Endpoints (under `/api/plugins/four43.web-push`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vapid-key` | Get VAPID public key (no auth required) |
| POST | `/subscribe` | Save push subscription `{endpoint, keys: {p256dh, auth}}` |
| DELETE | `/subscribe` | Remove push subscription `{endpoint, keys: {p256dh, auth}}` |

## How It Works

1. **Startup**: Generates VAPID key pair (or loads existing) via `py_vapid`. Registers listener for `four43.room-type-chat:message` events.
2. **On new message**: For each room member (excluding sender), checks `core_api.is_user_connected()`. If no active WS connection, fetches their push subscriptions and sends via `pywebpush`.
3. **Frontend**: On init, checks browser Push API support. If permission granted (or requests it), subscribes via `PushManager.subscribe()` with the VAPID public key, then POSTs the subscription to the backend.
4. **Cleanup**: On `WebPushException` with status 404/410, automatically removes the stale subscription.

## Dependencies

- `pywebpush` — Web Push protocol implementation
- `py_vapid` — VAPID key generation
- `cryptography` — Key encoding

## Key Details

- VAPID keys are singleton (id=1 constraint), generated once and reused
- Depends on `four43.room-type-chat` events (listens for `four43.room-type-chat:message`)
- `capabilities: ["web_push"]`
- Frontend exports as `window["Four43.web-pushPlugin"]`
