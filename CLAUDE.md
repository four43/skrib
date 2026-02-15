# Mini Chat

Real-time chat app with WebAuthn/Passkey auth. FastAPI backend, vanilla JS frontend, SQLite DB, WebSocket messaging.

## Detailed Documentation

Read these files on demand when working on specific areas:

- **Backend API & structure**: `backend/README.md`
- **Frontend architecture**: `frontend/README.md`
- **WebAuthn testing**: `docs/playwright-webauthn-testing.md`
- **Feature planning**: `docs/planning-feature-list.md`
- **E2E encryption design**: `docs/end-to-end-encryption.md`

## Project Structure

```
backend/mini_chat/       # FastAPI app
  auth/                  # WebAuthn registration/login
  rooms/                 # Chat rooms, DMs, IRC features (topic, roles)
  ws/                    # Unified WebSocket bus (single connection per client)
  messages/              # Message search
  admin/                 # User management, settings
  database.py            # SQLite + WAL mode
  dependencies.py        # Auth middleware
  main.py                # App entry & router registration

frontend/src/            # Vanilla JS (Vite build)
  chat.js                # Main chat (WebSocket, rooms, DMs, messages)
  login.js / register.js # Auth pages
  utils.js               # Shared utilities
  style.css              # All styles
```

## Key Conventions

- Backend modules follow: `routes.py` (endpoints), `schemas.py` (Pydantic), `services.py` (logic)
- Frontend exposes functions via `window.{funcName}`
- Auth: WebAuthn credentials, session tokens in `Authorization: Bearer {token}`
- WebSocket auth via query param: `?token={sessionToken}`
- Messages use `?since={lastMessageId}` for deduplication (exclusive, returns id > since)
- Rooms use soft-delete (`deleted` flag)
- First registered user is auto-approved as admin

## Room Types

- **Channels**: `room_type='channel'`, names must be lowercase + hyphens (regex `^[a-z0-9]+(-[a-z0-9]+)*$`), displayed with `#` prefix
- **DMs**: `room_type='dm'`, auto-generated `room_id` as `dm|user_a|user_b` (pipe-delimited, sorted), membership tracked in `room_users` table
- `GET /rooms` returns channels (where user is a member) and DMs (where user is a member), with `display_name` field

## Unified WebSocket Bus

- Single WS connection per client at `WS /api/ws?token=...`
- Two namespaces: `system.*` (connection-level) and `room.*` (all room traffic)
- **User-scoped** events (`room.update`, `room.new_message`) go to all of a user's tabs
- **Room-scoped** events (`room.message`, `room.topic`) go only to tabs that sent `room.join`
- Client sends `room.join`/`room.leave` when switching rooms (no WS teardown)
- Messages sent via `room.message` (from client) or HTTP `POST /rooms/{room_id}/messages`
- Implementation in `backend/mini_chat/ws/` (manager.py, handlers.py, routes.py)

## Running

```bash
# Backend
cd backend && pip install -e . && uvicorn mini_chat.main:app --reload --host 0.0.0.0 --port 8000

# Frontend
cd frontend && npm install && npm run dev  # port 5173

# Docker
docker-compose up --build
```

## Debugging

- Backend logs: `[WS]`, `[HTTP]`, `[DEBUG]` prefixes in console
- Frontend logs: `[WS]`, `[HTTP]` in browser console
- WebSocket frames: browser DevTools > Network > WS
