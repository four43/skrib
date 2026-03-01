# Progressive Web App

Skrib is installable as a standalone Progressive Web App with offline asset caching and Web Push notification support.

## Web App Manifest

Defined in `frontend/public/manifest.json`:

| Property | Value |
|---|---|
| `name` | Skrib |
| `short_name` | Skrib |
| `display` | `standalone` |
| `start_url` | `/app.html` |
| `theme_color` | `#6366f1` |
| `background_color` | `#1a1a2e` |

Icons are provided at 192x192 (standard) and 512x512 (standard + maskable) in `frontend/public/icons/`.

When installed, Skrib runs as a standalone app without browser chrome, with its own task bar entry and app icon.

## Service Worker

Located at `frontend/public/sw.js`. Uses a named cache (`skrib-v2`) with strategy-based fetch handling.

### Cache Strategies

| URL Pattern | Strategy | Rationale |
|---|---|---|
| `/assets/*` | Cache-first | Vite-hashed filenames are immutable; serve from cache, never revalidate |
| Navigation requests | Stale-while-revalidate | Serve cached page instantly, update cache in background |
| Other static files | Stale-while-revalidate | Keep UI responsive, update silently |
| `/api/*` | Network-only (no cache) | API data must be fresh |
| WebSocket | Passthrough | Not cacheable |

### Pre-cached Assets

On install, the service worker pre-caches:

- `/app.html`
- `/login.html`
- `/manifest.json`
- `/icons/icon-192x192.png`

### Lifecycle

- **Install**: Pre-caches critical assets, calls `skipWaiting()` for immediate activation
- **Activate**: Cleans up old caches (any cache not matching `skrib-v2`), calls `clients.claim()` to take control of all tabs
- **Fetch**: Applies cache strategies based on URL pattern

## Web Push Notifications

Implemented by the `four43.web-push` plugin.

### Architecture

1. **Frontend** (`four43.web-push/frontend/plugin.js`):
   - Requests notification permission from the user
   - Subscribes to the Push API using VAPID public key from backend
   - Sends the push subscription to the backend via `POST /api/plugins/four43.web-push/subscribe`

2. **Backend** (`four43.web-push/backend/plugin.py`):
   - Stores push subscriptions per user
   - Listens to `four43.room-type-chat:message` events on the PluginBus
   - When a message is sent, sends push notifications to all offline room members
   - Uses VAPID (Voluntary Application Server Identification) for authentication with push services

3. **Service Worker** (`sw.js`):
   - Handles the `push` event, displays a notification with title, body, and icon
   - On notification click: focuses the existing Skrib tab or opens a new window to `/app.html`

### VAPID Keys

The backend generates VAPID keys on first startup and stores them in the plugin's database. The public key is served to clients via `GET /api/plugins/four43.web-push/vapid-key`.

## Mobile Support

The PWA includes mobile-specific optimizations in the frontend:

| Feature | Implementation |
|---|---|
| Responsive sidebar | Toggle button, overlay mode, swipe-to-open (30px edge zone, 60px threshold) |
| Auto-hiding topbar | Hides on scroll down, reappears on scroll up or tap |
| Keyboard hints | `enterkeyhint="send"` on message input |
| Auto-capitalize | `autocapitalize="sentences"` on message input |
| Members panel | Toggleable with persisted preference |
| WebSocket reconnect | Reconnects on `visibilitychange` when tab resumes from background |

## Implementation Files

| File | Role |
|---|---|
| `frontend/public/manifest.json` | PWA manifest |
| `frontend/public/sw.js` | Service Worker (caching, push events) |
| `frontend/public/icons/` | App icons (192px, 512px) |
| `backend/plugins/four43.web-push/` | Push notification plugin (subscription, delivery) |
| `frontend/src/app.js` | Service worker registration, mobile UI handling |
