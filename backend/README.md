# API Structure Documentation

## Overview

The API has been reorganized following FastAPI best practices with feature-based modules. Each module contains its own routes, schemas, and business logic.

## Directory Structure

```
backend/mini_chat/
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
|--------|----------|-------------|
| GET | `/auth/register/begin` | Begin WebAuthn registration |
| POST | `/auth/register/complete` | Complete registration |
| GET | `/auth/login/begin` | Begin WebAuthn login |
| POST | `/auth/login/complete` | Complete login |
| GET | `/auth/session` | Check session validity |

### Rooms (`/api/rooms`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/rooms` | List rooms visible to user (channels + own DMs) |
| WS | `/rooms` | Subscribe to room list updates (same path, upgraded) |
| POST | `/rooms` | Create a channel (name: lowercase + hyphens) |
| POST | `/rooms/dm` | Create or get a DM with another user |
| DELETE | `/rooms/{room_id}` | Soft-delete a room (admin only) |
| GET | `/rooms/{room_id}/messages` | Get messages in a room |
| POST | `/rooms/{room_id}/messages` | Send message to a room |
| WS | `/rooms/{room_id}/ws` | Real-time chat in a room |

### Users (`/api/users`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users` | List all users (admin only) |
| GET | `/users/list` | List usernames (authenticated, for DM picker) |
| GET | `/users/pending` | List pending approvals (admin only) |
| POST | `/users/pending/approve` | Approve a user (admin only) |
| POST | `/users/pending/reject` | Reject a user (admin only) |
| DELETE | `/users/{username}` | Delete a user (admin only) |
| PUT | `/users/{username}/role` | Set user role (admin only) |
| GET | `/users/preferences/colors` | All users' color preferences |
| GET | `/users/{username}/preferences` | Get user preferences |
| PUT | `/users/{username}/preferences` | Update user preferences |

### Messages (`/api/messages`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/messages` | Search messages globally |

**Query Parameters:**

- `query`: Search text in messages
- `room_id`: Filter by room
- `username`: Filter by user
- `limit`: Number of results (1-500, default 100)
- `offset`: Results to skip (for pagination)

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
python -m uvicorn mini_chat.main:app --reload --host 0.0.0.0 --port 8000
```

### Use the Admin CLI

```bash
# Interactive mode
python mini_chat/admin_cli.py

# Direct commands
python mini_chat/admin_cli.py list
python mini_chat/admin_cli.py approve ABC123DEF456
python mini_chat/admin_cli.py set-admin alice
python mini_chat/admin_cli.py status

# Remote API
python mini_chat/admin_cli.py --url http://remote-server:8000 status
```

## Migration Notes

### Old Structure → New Structure

| Old | New |
|-----|-----|
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
