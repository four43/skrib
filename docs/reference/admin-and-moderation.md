# Admin and Moderation

Skrib provides admin and moderation tools for managing users, controlling access, and configuring the server.

## Roles

| Role | Scope | Description |
|---|---|---|
| `admin` | Global | Full server control: settings, user management, plugins, all room operations, approve/deny join requests |
| `moderator` | Global | User approval, room folder management, kick users, approve/deny join requests |
| `user` | Global | Standard access: join rooms, send messages, create rooms, request to join public rooms |

The first registered user is automatically approved and assigned the `admin` role. The last admin cannot be demoted.

## Admin Panel

Accessible at `/admin.html` (requires `admin` role).

### Server Settings

| Setting | Description |
|---|---|
| Server Name | Display name shown in the UI and multi-server selector |
| Server Icon | Custom upload (PNG, resized to 128x128) or auto-generated identicon |
| Registration Mode | `open`, `approval_required`, `invite_only`, or `closed` |
| Default Theme | Server-wide theme applied to new users |
| DM Room Type | Which plugin room type is used for direct messages |

### User Management

- **List users**: View all users with their status (`active`, `pending`, `rejected`) and role
- **Approve/reject**: Pending users awaiting approval (in `approval_required` mode)
- **Change role**: Promote or demote users between `admin`, `moderator`, and `user`
- **Delete user**: Remove a user entirely

### Invite Management

In `invite_only` mode:

- **Create invite**: Generate a single-use invite token via `POST /api/server/invites`
- **List invites**: View active invite tokens
- **Share**: Invite link includes the token as a query parameter

> **Changing.** `docs/spec/2026-08-02-onboarding-invite-links.md` reworks this
> substantially: `invite_only` becomes the seeded default, the link carries a
> key-wrapping secret **in the URL fragment** rather than a token in the query
> string (a query parameter would be sent to the server and would break the
> zero-knowledge property), and the link stays valid until the user completes
> enrollment rather than being single-use.

### Plugin Management

- **List plugins**: View all discovered plugins with their manifests and enabled status
- **Enable/disable**: Toggle plugins via `PATCH /api/plugins/{plugin_id}` (requires server restart for full effect)
- **Approve/reject/disable**: Bus-connected plugins additionally require admin approval before they can send any frame, via `GET/POST/DELETE /api/admin/plugins/*`. A change to a plugin's security-relevant manifest fields re-triggers approval. See `docs/reference/plugin-system.md` §11.

## Theme System

Themes are CSS files discovered from the `backend/themes/` directory.

- Admin sets a server-wide default theme
- Users can override the theme in their personal settings
- Color scheme options: `auto` (follows OS preference via `prefers-color-scheme`), `light`, `dark`
- Themes are cached in `localStorage` on the client to prevent flash of unstyled content (FOUC)
- Theme CSS served via `GET /api/themes/{theme_id}` with cache headers (`max-age=300`)

## Multi-Server Support

The frontend supports connecting to multiple Skrib servers:

- Server list stored in `localStorage`
- Server strip rendered in the sidebar showing server icons
- Each server is validated via `GET /api/server` before being added
- Users can add, select, and remove servers

## User Settings

Accessible at `/settings.html` (all users):

| Setting | Description |
|---|---|
| Display Name | Nickname shown instead of username (also settable via `/nick` command) |
| Theme | Override server default theme |
| Color Scheme | `auto`, `light`, or `dark` |
| Avatar | Custom upload or auto-generated identicon |

## Avatars

- Auto-generated on registration using a deterministic identicon algorithm
- Based on SHA-256 hash of the username: 5x5 symmetric grid with 3 tonal color variants
- Rendered as 128px PNG using Pillow
- Replaceable with custom upload via user settings

## REST API

### Server Settings

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/server` | Get server info (name, icon, settings) |
| `PATCH` | `/api/server` | Update server settings (admin only) |
| `POST` | `/api/server/invites` | Create an invite token (admin only) |
| `GET` | `/api/server/invites` | List invite tokens (admin only) |

### User Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/users` | List all users (admin only) |
| `GET` | `/api/users/{username}` | Get user details |
| `PATCH` | `/api/users/{username}` | Update user (role, status, settings) |
| `DELETE` | `/api/users/{username}` | Delete user (admin only) |
| `POST` | `/api/users/{username}/approve` | Approve a pending user (admin/moderator) |
| `POST` | `/api/users/{username}/reject` | Reject a pending user (admin/moderator) |

### Plugins

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/plugins` | List all plugins with manifests |
| `PATCH` | `/api/plugins/{plugin_id}` | Enable or disable a plugin (admin only) |

### Themes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/themes` | List available themes |
| `GET` | `/api/themes/{theme_id}` | Get theme CSS |

## Implementation Files

| File | Role |
|---|---|
| `frontend/src/admin.js` | Admin panel UI |
| `frontend/src/settings.js` | User settings page |
| `frontend/src/server-selector.js` | Multi-server UI |
| `frontend/src/theme-manager.js` | Theme loading and caching |
| `backend/skrib/server/routes.py` | Server settings and invite endpoints |
| `backend/skrib/server/services.py` | Server settings logic |
| `backend/skrib/users/routes.py` | User management endpoints |
| `backend/skrib/users/services.py` | User CRUD logic |
| `backend/skrib/users/avatar.py` | Identicon generation |
| `backend/skrib/themes/routes.py` | Theme discovery and serving |
| `backend/skrib/plugins/routes.py` | Plugin management API |
