# Users

Users are individuals who register and interact with the Skrib system. Authentication is passwordless via WebAuthn/Passkeys.

## User Model

| Field | Type | Description |
|---|---|---|
| `username` | TEXT (PK) | Unique identifier. 4-15 chars, alphanumeric + underscores. Reserved words blocked: `admin`, `skrib`, `system`. |
| `credential_id` | TEXT | WebAuthn credential reference |
| `public_key` | TEXT | WebAuthn public key for login verification |
| `status` | TEXT | `pending` or `active` |
| `role` | TEXT | `admin`, `moderator`, or `user` |
| `approval_code` | TEXT | 6-char hex code shown to the user for admin approval |
| `encryption_public_key` | TEXT | E2E encryption public key (JWK format) |
| `color` | TEXT | Display color (hex). Assigned round-robin from a 10-color palette on registration. |
| `nickname` | TEXT | Optional display name override |
| `theme_name` | TEXT | Selected theme plugin ID |
| `color_scheme` | TEXT | `auto`, `light`, or `dark` |
| `status_emoji` | TEXT | User status emoji (up to 8 chars) |
| `status_text` | TEXT | User status message (up to 128 chars) |
| `avatar_data` | BLOB | Auto-generated identicon PNG derived from username + color |
| `encrypted_private_key` | TEXT | PRF-wrapped E2E private key backup |
| `passphrase_encrypted_private_key` | TEXT | Passphrase-wrapped E2E private key backup |
| `created_at` | TEXT | Registration timestamp |
| `approved_at` | TEXT | When the user was approved |
| `approved_by` | TEXT | Who approved (`system`, `open`, `invite`, or an admin's username) |

## Registration

Registration is a multi-step WebAuthn flow:

1. **Username submission** (`POST /auth/register`) -- user picks a username, server validates it and returns a short-lived registration token (5-minute TTL).
2. **Challenge request** (`GET /auth/register/begin`) -- client exchanges the registration token for a WebAuthn challenge and relying party info.
3. **Credential creation** (`POST /auth/register/complete`) -- client submits the signed WebAuthn credential (credentialId, publicKey, challenge) and optional E2E encryption keys. Server creates the user and returns either an `approved` status or `pending` with an approval code.

### Registration Modes

The server has a configurable registration mode (set by admins via `PATCH /server`):

| Mode | Behavior |
|---|---|
| `closed` | Registration disabled entirely |
| `invite_only` | Requires a valid invite token (created by admins via `POST /server/invites`) |
| `approval_required` | Default. New users are created with `pending` status and must be approved by an admin or moderator. |
| `open` | All new users are auto-approved on registration |

### Auto-Approval Rules

Regardless of registration mode, certain conditions trigger automatic approval:

- **First user**: The very first user to register is auto-approved as `admin` (approved_by=`system`). This bootstraps the system.
- **Invite-only with valid token**: Auto-approved (approved_by=`invite`).
- **Open mode**: Auto-approved (approved_by=`open`).

## Login

Login is usernameless -- the client presents any discoverable passkey credential:

1. **Challenge request** (`GET /auth/login/begin`) -- server returns a WebAuthn challenge with empty `allowCredentials`.
2. **Credential verification** (`POST /auth/login/complete`) -- client submits credentialId and signed challenge. Server looks up the user by credential_id, verifies the signature, and returns a session token + username + role.

## Sessions

- **Token format**: Base64-encoded `"username:random_hex"`.
- **Transport**: `Authorization: Bearer {token}` header for HTTP; `?token={token}` query param for WebSocket.
- **Validation**: On every request, the token is decoded, and the user is checked against the database (must exist with `status=active`).
- **No expiration**: Tokens are stateless and do not expire. Validity depends on the user record remaining active.

## Global Roles

| Role | Description |
|---|---|
| `admin` | Full system access. Can manage server settings, users, rooms, folders, and invites. |
| `moderator` | Can approve/reject users, manage rooms and folders. Cannot change server settings or delete users. |
| `user` | Default role. Standard access -- can create rooms, send messages, manage own profile. |

### Role Assignment

- The first registered user is automatically assigned `admin`.
- Admins can change any user's role via `PATCH /users/{username}` with `{role: "admin"|"moderator"|"user"}`.
- The system prevents deleting or demoting the last admin.

## User Approval

When `registration_mode` is `approval_required`, new users enter `pending` status:

- The user receives a 6-character hex approval code to share with an admin.
- Admins or moderators approve via `PATCH /users/pending/{approval_code}` with `{status: "approved"}`.
- Rejection uses the same endpoint with `{status: "rejected"}`.
- Pending users cannot log in or access the system.

## User Preferences

Users can update their own preferences via `PATCH /users/{username}`:

| Preference | Description |
|---|---|
| `color` | Display color (hex). Regenerates avatar when changed. |
| `nickname` | Display name shown alongside username |
| `theme_name` | Theme plugin to use |
| `color_scheme` | Theme variant: `auto`, `light`, or `dark` |
| `status_emoji` | Status emoji (up to 8 chars) |
| `status_text` | Status message (up to 128 chars) |

Admins can update any user's preferences or role. Non-admins can only update their own.

## Avatars

- Auto-generated identicon PNGs derived from username + color.
- Served publicly (no auth) at `GET /users/{username}/avatar`.
- Cached in the browser for 1 hour.
- Regenerated when the user's color changes.

## Presence

- `GET /users/{username}/presence` -- check if a specific user is online.
- `GET /users/presence` -- get online status for all users.
- Presence is based on active WebSocket connections.

## Room Membership

Users interact with rooms through the `room_users` table. See [Rooms and Membership](rooms-and-membership.md) for full details.

**Room roles**: `owner`, `op`, `voice`, `member` -- these are separate from global roles.

**Key behaviors**:
- Room creators are auto-assigned `owner`.
- New members added via invite default to `member`.
- Global `admin` and `moderator` roles can override room-level permissions for moderation.
- Each membership tracks `notify_level` (`all`, `mentions`, `muted`) and `last_read_message_id` for unread counts.

## E2E Encryption Keys

Users can store encryption keys for end-to-end encrypted rooms:

- `encryption_public_key` -- RSA public key (JWK) stored on registration or via `POST /auth/encryption-key`.
- `encrypted_private_key` -- PRF-wrapped private key backup (device-bound recovery).
- `passphrase_encrypted_private_key` -- passphrase-wrapped private key backup (cross-device recovery).
- Other users' public keys are fetchable via `GET /auth/encryption-key/{username}` for key distribution.

## User Deletion

- Admins can delete users via `DELETE /users/{username}`.
- The last admin cannot be deleted.
- Deletion removes the user record and cascades through foreign keys (room memberships, keys, etc.).

## Admin CLI

A command-line tool (`admin_cli.py`) provides administrative shortcuts:

| Command | Description |
|---|---|
| `list` | List pending users with approval codes |
| `approved` | List all approved users with roles |
| `approve <code>` | Approve a pending user |
| `reject <code>` | Reject a pending user |
| `revoke <username>` | Delete a user |
| `set-admin <username>` | Promote user to admin |
| `remove-admin <username>` | Demote user from admin |
| `toggle-reg` | Cycle registration mode |
| `status` | Show system stats |

## REST API

### Authentication

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/auth/register` | Start registration (submit username) | None |
| `GET` | `/auth/register/begin` | Get WebAuthn challenge for registration | Registration token |
| `POST` | `/auth/register/complete` | Complete registration with credential | None |
| `GET` | `/auth/login/begin` | Get WebAuthn challenge for login | None |
| `POST` | `/auth/login/complete` | Complete login, receive session token | None |
| `GET` | `/auth/session` | Check session validity | Optional Bearer |
| `POST` | `/auth/encryption-key` | Store E2E encryption keys | Bearer |
| `GET` | `/auth/encryption-key/{username}` | Get user's E2E public key | Bearer |

### User Management

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/users` | List users (filter by `?status=pending\|active`) | Bearer |
| `GET` | `/users/{username}` | Get user profile | Bearer |
| `PATCH` | `/users/{username}` | Update preferences or role | Bearer (self or admin) |
| `DELETE` | `/users/{username}` | Delete user | Admin |
| `PATCH` | `/users/pending/{approval_code}` | Approve or reject pending user | Moderator+ |
| `GET` | `/users/{username}/avatar` | Get avatar image | None (public) |
| `GET` | `/users/{username}/presence` | Check if user is online | Bearer |
| `GET` | `/users/presence` | Get all users' online status | Bearer |
| `GET` | `/users/preferences/colors` | Get all users' display colors | Bearer |

### Server (Admin)

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/server` | Get server info | None |
| `PATCH` | `/server` | Update server settings (registration_mode, name, etc.) | Admin |
| `POST` | `/server/invites` | Create invite token | Admin |
| `GET` | `/server/invites` | List invite tokens | Admin |
| `DELETE` | `/server/invites/{token}` | Revoke invite token | Admin |

## Permissions Summary

| Operation | Required Permission |
|---|---|
| Register | Public (if registration mode allows) |
| Log in | Active user with valid passkey |
| Update own profile | Authenticated |
| Update another user's profile | Admin |
| Change a user's role | Admin |
| Approve/reject pending users | Admin or Moderator |
| Delete a user | Admin |
| Manage server settings | Admin |
| Manage invite tokens | Admin |
| Create a room | Authenticated |
| View/manage rooms | See [Rooms and Membership](rooms-and-membership.md) |

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/auth/routes.py` | Registration and login endpoints |
| `backend/skrib/auth/services.py` | Auth logic, token creation, WebAuthn verification |
| `backend/skrib/users/routes.py` | User CRUD, preferences, avatar, presence |
| `backend/skrib/users/services.py` | User business logic, approval, deletion |
| `backend/skrib/users/schemas.py` | Pydantic models for user operations |
| `backend/skrib/admin_cli.py` | CLI admin commands |
| `backend/skrib/server/routes.py` | Server settings and invite management |
| `backend/skrib/dependencies.py` | Auth middleware (`require_auth`, `require_admin`, `require_moderator`) |
| `backend/skrib/permissions.py` | Permission helpers (global role checks, room-level overrides) |
| `backend/skrib/database.py` | Schema definitions (users table, sessions, challenges) |

---

## Planned API Changes

### Problem

The current users API splits user data across too many endpoints, forcing clients to make multiple calls and merge results:

- `GET /users` returns admin-oriented fields (role, status, approval_code, approved_at/by) but no display metadata.
- `GET /users/preferences/colors` returns the display metadata (color, nickname, status_emoji, status_text) that the frontend actually needs for rendering messages and avatars.
- `GET /users/presence` is yet another separate call for online status.
- The admin panel calls both `/users` and `/users/preferences/colors` in parallel and merges them client-side.
- `GET /users/{username}` returns private preferences (theme_name, color_scheme) that are only useful to the user themselves.

### Changes

#### 1. `GET /users` returns display metadata by default

The base response becomes the common case -- basic identity and display info for all active users:

```json
[
  {
    "username": "alice",
    "nickname": "Alice",
    "color": "#e377c2",
    "status": { "emoji": "🚀", "text": "shipping features" }
  }
]
```

#### 2. `?detail=admin` for admin-oriented data

Admin/moderator callers can request the full picture. This adds role, account_status, approval info, and timestamps. Requires `admin` or `moderator` role -- returns 403 otherwise.

```
GET /users?detail=admin
```

```json
[
  {
    "username": "alice",
    "nickname": "Alice",
    "color": "#e377c2",
    "status": { "emoji": "🚀", "text": "shipping features" },
    "role": "admin",
    "account_status": "active",
    "approval": { "code": null, "time": "2026-03-15T10:00:00", "by": "system" },
    "created_at": "2026-03-15T09:58:00"
  }
]
```

`?detail=admin` also unlocks account_status filtering: `GET /users?detail=admin&account_status=pending` to list pending users. Without `detail=admin`, only active users are returned.

#### 3. Remove `GET /users/preferences/colors`

This endpoint is redundant once `GET /users` returns display metadata. Remove it and update the two frontend callers:

- `frontend/src/app.js` `loadUserColors()` -- switch to `GET /users`
- `frontend/src/admin.js` `loadUserPreferences()` -- switch to single `GET /users?detail=admin` call instead of fetching both endpoints

#### 4. Fold presence into `GET /users`

Add an optional `?include=presence` query param that adds a `connected` boolean to each user object. This avoids a separate round-trip for presence data.

```
GET /users?include=presence
```

```json
[
  {
    "username": "alice",
    "nickname": "Alice",
    "color": "#e377c2",
    "status": { "emoji": "🚀", "text": "shipping features" },
    "connected": true
  }
]
```

`include=presence` can be combined with `detail=admin`. The single-user presence endpoint `GET /users/{username}/presence` remains unchanged for targeted lookups.

#### 5. Trim `GET /users/{username}` private fields

`theme_name` and `color_scheme` are private preferences only useful to the user themselves. Move them behind a self-only check:

- If the caller is requesting their own profile: return all fields (including theme_name, color_scheme).
- If requesting another user's profile: omit theme_name and color_scheme.

#### 6. Remove `GET /users/presence`

Superseded by `GET /users?include=presence`. The single-user endpoint `GET /users/{username}/presence` stays.

### Migration Summary

| Before | After |
|---|---|
| `GET /users` | `GET /users` (now returns display metadata) |
| `GET /users?status=pending` | `GET /users?detail=admin&status=pending` (requires moderator+) |
| `GET /users/preferences/colors` | `GET /users` (removed, folded in) |
| `GET /users/presence` | `GET /users?include=presence` (removed, folded in) |
| `GET /users/{username}` (any caller sees theme) | `GET /users/{username}` (theme fields only for self) |
