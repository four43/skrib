# Skrib

A self-hosted, end-to-end encrypted collaboration platform. Passwordless authentication via passkeys, a plugin-based room system, and installable as a Progressive Web App. Zero-knowledge server design means the server never sees plaintext message content.

## Feature Overview

| Feature | Description | Spec |
|---|---|---|
| End-to-End Encryption | AES-GCM 256-bit per-room keys, RSA-OAEP key exchange, epoch-based rotation | [docs/end-to-end-encryption.md](docs/end-to-end-encryption.md) |
| Plugin System | Sandboxed plugins with manifest permissions, isolated storage, lifecycle hooks | [docs/plugin-system.md](docs/plugin-system.md) |
| Security & Authentication | WebAuthn/Passkey auth, PRF key wrapping, registration modes, role-based access | [docs/security.md](docs/security.md) |
| Progressive Web App | Installable standalone app, offline caching, Web Push notifications | [docs/progressive-web-app.md](docs/progressive-web-app.md) |
| WebSocket Bus | Single-connection multiplexed messaging with namespace routing | [docs/websocket-bus.md](docs/websocket-bus.md) |
| Rooms & Membership | Plugin-typed rooms, nestable folders, roles, DMs, notification controls | [docs/rooms-and-membership.md](docs/rooms-and-membership.md) |
| Admin & Moderation | User approval, invite tokens, server settings, theme management | [docs/admin-and-moderation.md](docs/admin-and-moderation.md) |
| Architecture | FastAPI + Vanilla JS, SQLite WAL, module conventions, deployment | [docs/architecture.md](docs/architecture.md) |

## Highlights

- **Zero-knowledge**: All message content is encrypted client-side before transmission. The server stores only ciphertext.
- **No passwords**: Authentication uses platform passkeys (biometrics, security keys). No passwords to leak or phish.
- **Key portability**: Private keys travel between devices via WebAuthn PRF wrapping (automatic) or passphrase recovery (manual).
- **Plugin architecture**: Room behavior is defined by plugins. Ship with chat rooms, todo lists, typing indicators, emoji reactions, and Web Push. Add your own.
- **Self-hosted**: Single SQLite database, single Docker container. No external dependencies.

## Quick Start

### Docker

```bash
docker-compose up --build
```

App available at http://localhost:8000. The first registered user is automatically approved as admin.

### Local Development

```bash
# Backend
cd backend && pip install -e . && uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

Backend runs on port 8000, frontend dev server on port 5173 with API proxying.

### First Run

1. Navigate to the app and register with a username + recovery passphrase
2. Enroll a passkey using your platform authenticator (fingerprint, Face ID, security key)
3. The first user is auto-approved and made admin
4. Configure registration mode in the admin panel (Settings > Registration)

## Project Structure

```
backend/
  skrib/                    # FastAPI application
    auth/                   # WebAuthn registration and login
    rooms/                  # Room CRUD, member management, key endpoints
    room_folders/           # Nestable folder system
    ws/                     # Unified WebSocket bus
    users/                  # User management, avatars
    server/                 # Server settings, invites
    themes/                 # Theme discovery and serving
    plugins/                # Plugin framework (registry, bus, auth, callbacks)
    database.py             # SQLite + WAL mode
    dependencies.py         # Auth middleware
    permissions.py          # Centralized permission checks
    main.py                 # App entry, router registration
  plugins/                  # Installed plugins
    four43.room-type-chat/  # Chat room type
    four43.room-type-todo/  # Todo list room type
    four43.chat-typing/     # Typing indicators
    four43.message-reactions/  # Emoji reactions
    four43.web-push/        # Web Push notifications

frontend/
  src/
    app.js                  # Main application (~2700 lines)
    crypto.js               # E2E encryption (RSA-OAEP, AES-GCM, key wrapping)
    login.js                # Passkey login + key recovery
    register.js             # Registration flow
    enroll-passkey.js       # Passkey enrollment + key generation
    key-recovery.js         # Passphrase-based key recovery
    admin.js                # Admin panel
    settings.js             # User settings
    room-settings.js        # Per-room settings
    server-selector.js      # Multi-server support
    theme-manager.js        # Theme loading and caching
    utils.js                # Shared utilities
  public/
    sw.js                   # Service Worker (caching, push)
    manifest.json           # PWA manifest

data/                       # SQLite databases (gitignored)
docs/                       # Feature specs (this directory)
```

## Bundled Plugins

| Plugin | Type | Description |
|---|---|---|
| `four43.room-type-chat` | Room Type | Encrypted chat with message history, edit/delete, read receipts, desktop notifications |
| `four43.room-type-todo` | Room Type | Collaborative todo lists with real-time sync, filtering, inline editing |
| `four43.chat-typing` | Feature | Typing indicators with debounce and auto-timeout |
| `four43.message-reactions` | Feature | Emoji reactions on messages with batch loading |
| `four43.web-push` | Feature | Web Push notifications for offline users via VAPID |

## Slash Commands

| Command | Description |
|---|---|
| `/help` | List available commands |
| `/invite <username>` | Invite a user to the current room (distributes encryption keys) |
| `/nick <name>` | Set display nickname (`/nick clear` to reset) |
| `/leave` or `/part` | Leave the current channel |
| `/kick <username>` | Remove a user (requires room op or moderator) |
| `/topic [text]` | View or set the channel topic |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RP_ID` | `localhost` | WebAuthn Relying Party ID (your domain) |
| `SKRIB_REGISTRATION_MODE` | (from DB) | Override registration mode: `open`, `closed`, `invite_only`, `approval_required` |
| `VITE_API_URL` | `/api` | Frontend API base URL (set in `frontend/.env.local` for dev) |

## API Documentation

With the server running:

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Browser Compatibility

Requires WebAuthn Level 2 support:

- Chrome/Edge 67+
- Firefox 60+
- Safari 14+ (13+ partial)

PRF extension (automatic key recovery) requires:

- Chrome/Edge 116+
- Safari 18+
- Firefox: not yet supported (falls back to passphrase recovery)

## Technology Stack

**Backend**: FastAPI, SQLite (WAL mode), py_webauthn, Pydantic, Uvicorn, Pillow (avatars)

**Frontend**: Vanilla JavaScript (ES modules), Vite, Web Crypto API, IndexedDB, SortableJS

**Infrastructure**: Docker, single-container deployment, no external services required
