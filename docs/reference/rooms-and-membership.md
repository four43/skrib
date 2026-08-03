# Rooms and Membership

Rooms are the primary organizational unit in Skrib. All room behavior is defined by plugins — a room's `room_type` determines which plugin handles its WebSocket actions, rendering, and storage.

## Room Model

| Field | Description |
|---|---|
| `room_id` | Primary key. DMs use format `dm\|user1\|user2` (sorted alphabetically) |
| `room_type` | Plugin-registered type (e.g., `chat`, `todo`) |
| `topic` | Optional room topic/description (default empty string) |
| `visibility` | `private` (default) or `public`. Controls discoverability and join requests. |
| `created_by` | Username of the room creator |
| `folder_id` | Optional reference to a room folder |
| `sort_position` | Position within a folder for ordering (REAL, default 0) |
| `created_at` | Creation timestamp |

Note: `is_dm` is not a database column — it is derived at runtime from the `room_id` prefix (`dm|`). The `is_dm()` helper function checks this.

Room creation validates `room_type` against currently enabled plugin room types. Attempting to create a room with an unregistered type is rejected.

### Room Name Validation

Channel names must match the pattern `^[a-z0-9]+(-[a-z0-9]+)*$`:
- Lowercase alphanumeric characters and hyphens only
- Cannot start or end with a hyphen
- No consecutive hyphens
- Examples: `general`, `my-room`, `dev-2`, `support-team`

Name availability can be checked via `GET /rooms/check-name?name={name}`.

## Room Visibility

Rooms have a `visibility` setting that controls discoverability:

| Visibility | Behavior |
|---|---|
| `private` | Default. Not searchable. Members added only via invite. Shown with a lock icon in the sidebar. |
| `public` | Searchable by all users via the "Add Channel" modal. Users can request to join. Shown with `#` prefix in the sidebar. |

DM rooms are always private and cannot have their visibility changed.

Visibility can be changed by room ops, owners, or global admins/moderators via room settings (`PATCH /rooms/{room_id}` with `{"visibility": "public"}`). Changing visibility broadcasts a `room:visibility_changed` WebSocket event to all room members.

The `PATCH /rooms/{room_id}` endpoint has split permissions:
- `topic` and `visibility` changes require room membership + op/owner/admin/moderator
- `folder_id` and `sort_position` changes require global admin/moderator (no room membership needed)

## Join Requests

Public rooms use a request-to-join flow rather than open membership:

1. User searches for public rooms via the "Add Channel" modal
2. User clicks "Request to Join" on a search result
3. Room ops/owners receive a real-time `room:join_request` WebSocket notification
4. An op/owner approves or denies the request (from the members panel or room settings page)
5. On approval, the requester is added as a `member` and receives `room:join_resolved`
6. On denial, the requester is notified and can re-request later

### Join Request Model

| Field | Description |
|---|---|
| `room_id` + `username` | Composite primary key |
| `status` | `pending`, `approved`, or `denied` |
| `created_at` | When the request was submitted |
| `resolved_by` | Username of the op who approved/denied |
| `resolved_at` | When the request was resolved |

Re-requesting after denial resets the status to `pending` and updates `created_at`.

### Join Request Info (API response)

The join request list endpoint returns enriched data:

| Field | Description |
|---|---|
| `room_id` | The room |
| `username` | The requesting user |
| `status` | Always `pending` (only pending requests are returned) |
| `created_at` | ISO timestamp |
| `nickname` | User's display nickname (if set) |
| `color` | User's hex color code (if set) |

### Permissions

- **Submit request**: Any authenticated user (room must be public, user must not already be a member)
- **View requests**: Room ops, owners, global admins/moderators
- **Approve/deny**: Room ops, owners, global admins/moderators

## Direct Messages

DMs are regular rooms with a deterministic ID format: `dm|alice|bob` (usernames sorted alphabetically, pipe-separated). This ensures only one DM room exists between any two users. Multi-user DMs follow the same pattern: `dm|alice|bob|charlie`.

There is no functional distinction between DMs and rooms at the data model level — the difference is in UI treatment (DMs are listed separately in the sidebar).

### DM Constraints

DMs have restrictions compared to regular channels:
- Cannot change visibility (always private)
- Cannot set or change topic
- Cannot set member roles
- Cannot be deleted via the delete room endpoint
- Cannot be left (members are permanent)
- Display name is computed from the other members' usernames relative to the viewer

### DM Creation

DMs are created via `POST /rooms/dm` with a list of usernames and optional room type. If the DM already exists, the existing room is returned instead of creating a duplicate.

## Membership

The `room_users` table tracks membership:

| Field | Description |
|---|---|
| `room_id` + `username` | Composite primary key |
| `room_role` | `owner`, `op`, `voice`, or `member` |
| `last_read_message_id` | Last message the user has read (for unread counts, INTEGER default 0) |
| `notify_level` | `all`, `mentions`, or `muted` |
| `joined_at` | When the user joined |

### Roles

| Role | Capabilities |
|---|---|
| `owner` | Full room control: settings, topic, members, delete, approve/deny join requests. Assigned to room creator. |
| `op` | Manage members, set topic, kick users, approve/deny join requests |
| `voice` | Standard participation (reserved for future use) |
| `member` | Read and send messages |

Global roles (`admin`, `moderator`) can override room roles for moderation purposes.

### Member Info (API response)

When fetching room details or member lists, each member includes:

| Field | Description |
|---|---|
| `username` | The member's username |
| `room_role` | `owner`, `op`, `voice`, or `member` |
| `joined_at` | ISO timestamp (nullable) |
| `nickname` | User's display nickname (nullable) |
| `color` | User's hex color code (nullable) |

### Adding Members

Adding members to a channel requires room op, owner, or global admin/moderator. Members are added via:

- REST API: `POST /rooms/{room_id}/members` (requires op/owner/admin/moderator)
- Slash command: `/invite <username>` (also distributes encryption keys)
- Room creation (creator is auto-added as `owner`)

When a member is invited via `/invite`, the inviter:

1. Adds them to the room via the API
2. Fetches their RSA public key
3. Encrypts all room key epochs for the new member
4. Uploads the encrypted keys to the server (storing keys for another user requires op/owner/admin/moderator)

### Removing Members

- REST API: `DELETE /rooms/{room_id}/members/{username}`
- Slash command: `/kick <username>` (requires room op or global moderator)
- Self-removal: `/leave` or `/part`

### Updating Members

Member properties can be updated via `PATCH /rooms/{room_id}/members/{username}`:

| Field | Description |
|---|---|
| `notify_level` | Change notification preference (`all`, `mentions`, `muted`) |
| `room_role` | Change the member's role (requires op/owner/admin) |

Individual member details can be fetched via `GET /rooms/{room_id}/members/{username}`.

### Notification Levels

Per-room notification preference:

| Level | Behavior |
|---|---|
| `all` | Notify on every new message |
| `mentions` | Notify only on @mentions (reserved for future implementation) |
| `muted` | No notifications (unread count still tracked) |

### Unread Counts

Unread tracking is delegated to room-type plugins via the callback system:

1. Client marks a room as read: `POST /rooms/{room_id}/read` with `last_read_message_id`
2. Unread count computed by the plugin callback (`/unread-count` or `/unread-counts-batch`)
3. Sidebar displays unread badge per room (capped at `99+`)

### Slash Commands

| Command | Description |
|---|---|
| `/invite @username` | Add a member and distribute encryption keys |
| `/kick @username` | Remove a member (requires op or moderator) |
| `/leave` or `/part` | Leave the current channel (not available for DMs) |
| `/topic [text]` | View or set the channel topic |

## Room Folders

Rooms can be organized into nestable folders.

### Folder Model

| Field | Description |
|---|---|
| `folder_id` | Primary key (UUID) |
| `name` | Folder name (same rules as room names, max 50 characters) |
| `parent_folder_id` | Reference to parent folder (adjacency list) |
| `position` | Sort position within parent (REAL) |
| `created_by` | Username of the folder creator |
| `created_at` | Creation timestamp |

### Folder Name Validation

Folder names follow the same rules as room/channel names and must match `^[a-z0-9]+(-[a-z0-9]+)*$`:
- Lowercase alphanumeric characters and hyphens only
- Cannot start or end with a hyphen
- No consecutive hyphens
- Maximum 50 characters
- Examples: `general`, `my-folder`, `dev-2`, `support-team`

### Constraints

- Maximum nesting depth: 5 levels
- Circular reference detection enforced
- Folder mutations (create, rename, move, delete) require `admin` or `moderator` role
- Deleting a folder moves its rooms and sub-folders to the root level (unfiles them)

### Endpoints

Folder endpoints live under `/api/rooms/folders`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/rooms/folders` | List all folders (tree structure) with room positions |
| `POST` | `/api/rooms/folders` | Create a folder |
| `PATCH` | `/api/rooms/folders/{folder_id}` | Rename or move a folder |
| `DELETE` | `/api/rooms/folders/{folder_id}` | Delete a folder |
| `POST` | `/api/rooms/folders/reorder` | Batch reorder rooms and folders |

Moving a room to a folder is done via `PATCH /api/rooms/{room_id}` with `folder_id` and `sort_position` fields (requires admin/moderator).

### Frontend

- SortableJS for drag-and-drop reordering of rooms within and between folders
- Collapsed state stored per-folder in `localStorage` (`skrib_collapsed_folders`)
- Unread badges on folders aggregate counts recursively across all nested rooms
- `room:folders_updated` WebSocket event triggers sidebar refresh for all connected users

## Room Deletion

Room deletion is a **hard delete**. When a room is deleted:

1. Room record removed from `rooms` table (CASCADE deletes room_users, room_keys, join_requests)
2. Plugin lifecycle hook `on_room_deleted(room_id, room_type)` fires — plugins clean up their own data (messages, reactions, etc.)
3. `room:update` event broadcast to all affected users

## Room Settings

Each room has a settings page (`/room-settings.html?room={room_id}`) accessible to room ops and owners:

- View and edit room topic (auto-saves on blur/Enter)
- Change room visibility (private/public) — ops/owners/admins only
- View and manage pending join requests (approve/deny) — ops/owners/admins only
- Manage member list with nicknames and colors displayed
  - Make/remove Op (owner/ops only, not on DMs)
  - Kick members (owner/ops only, not on DMs)
- Leave channel button (channels only, not DMs)
- Delete room (owner or admin only)

## WebSocket Events

### Client → Server

| Event | Description |
|---|---|
| `room:join` | Subscribe to a room's real-time events |
| `room:leave` | Unsubscribe from a room's events |
| `room:message` | Send a message (fields: room_id, content, content_type, key_epoch) |
| `room:edit_message` | Edit a message (fields: room_id, message_id, content, content_type, key_epoch) |
| `room:delete_message` | Delete a message (fields: room_id, message_id) |

### Server → Room Subscribers

Sent to all clients that have joined the room via `room:join`:

| Event | Description |
|---|---|
| `room:joined` | Acknowledgment that the client joined a room |
| `room:left` | Acknowledgment that the client left a room |
| `room:message` | New message broadcast |
| `room:message_edited` | Message edit broadcast |
| `room:message_deleted` | Message deletion broadcast |
| `room:members_updated` | Member list changed (add, remove, role change) |
| `room:topic` | Topic changed (fields: topic, set_by) |
| `room:visibility_changed` | Visibility changed (fields: visibility) |
| `room:error` | Error response for a failed room action |

### Server → User (all tabs)

Sent to all of a user's connected sessions, regardless of room subscription:

| Event | Description |
|---|---|
| `room:update` | Room list changed (join, leave, create, delete) — triggers sidebar refresh |
| `room:join_request` | New join request received (sent to room ops/owners) |
| `room:join_resolved` | Join request approved or denied (sent to the requester) |
| `room:folders_updated` | Folder structure changed — broadcast to all connected users |

### Plugin Lifecycle Events (internal)

Not sent to clients — used for inter-system communication:

| Event | Description |
|---|---|
| `core:room_created` | Fired after room creation (fields: room_id, room_type, creator) |
| `core:room_deleted` | Fired after room deletion (fields: room_id, room_type) |

## Room Search

Public rooms can be searched via `GET /rooms/search?q={query}`. Results include:

| Field | Description |
|---|---|
| `room_id` | The room identifier |
| `room_type` | Plugin type |
| `topic` | Room topic |
| `visibility` | Always `public` (only public rooms returned) |
| `member_count` | Number of current members |

Search excludes DMs and rooms the user is already a member of. The query is capped at 100 characters.

## Permissions Summary

| Operation | Required Permission |
|---|---|
| Create room | Authenticated user |
| Delete room | Room owner OR global admin (DMs cannot be deleted) |
| View room details | Room member |
| Add member | Room op/owner OR global admin/moderator |
| Remove member | Self, room op/owner, OR global admin/moderator |
| Change member role | Room op/owner OR global admin/moderator (not allowed in DMs) |
| Change topic | Room op/owner OR global admin/moderator |
| Change visibility | Room op/owner OR global admin/moderator (not allowed in DMs) |
| View join requests | Room op/owner OR global admin/moderator |
| Approve/deny join requests | Room op/owner OR global admin/moderator |
| Edit/delete a message | Message creator, room op/owner, OR global admin/moderator |
| Store keys for another user | Room op/owner OR global admin/moderator (target must be a member) |
| Move room to folder | Global admin or moderator |
| Manage folders | Global admin or moderator |

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/rooms` | List rooms where the user is a member |
| `POST` | `/api/rooms` | Create a new room (accepts `visibility` field) |
| `POST` | `/api/rooms/dm` | Create or get a DM room |
| `GET` | `/api/rooms/search?q={query}` | Search public rooms by name (excludes user's rooms, max 100 chars) |
| `GET` | `/api/rooms/check-name?name={name}` | Check if a room name is available |
| `GET` | `/api/rooms/folders` | List all folders (tree structure) with room positions |
| `POST` | `/api/rooms/folders` | Create a folder (admin/moderator) |
| `PATCH` | `/api/rooms/folders/{folder_id}` | Rename or move a folder (admin/moderator) |
| `DELETE` | `/api/rooms/folders/{folder_id}` | Delete a folder (admin/moderator) |
| `POST` | `/api/rooms/folders/reorder` | Batch reorder rooms and folders (admin/moderator) |
| `GET` | `/api/rooms/{room_id}` | Get room details (includes `visibility`, members with roles) |
| `PATCH` | `/api/rooms/{room_id}` | Update room metadata (topic, visibility, folder_id, sort_position) |
| `DELETE` | `/api/rooms/{room_id}` | Delete a room (not allowed for DMs) |
| `GET` | `/api/rooms/{room_id}/members` | List room members |
| `POST` | `/api/rooms/{room_id}/members` | Add a member (requires op/owner/admin/moderator) |
| `GET` | `/api/rooms/{room_id}/members/{username}` | Get individual member details |
| `PATCH` | `/api/rooms/{room_id}/members/{username}` | Update member (role, notify_level) |
| `DELETE` | `/api/rooms/{room_id}/members/{username}` | Remove a member |
| `POST` | `/api/rooms/{room_id}/join-requests` | Submit a join request (public rooms only) |
| `GET` | `/api/rooms/{room_id}/join-requests` | List pending join requests (ops/admins) |
| `PATCH` | `/api/rooms/{room_id}/join-requests/{username}` | Approve or deny a join request |
| `POST` | `/api/rooms/{room_id}/read` | Mark room as read |
| `GET` | `/api/rooms/{room_id}/keys` | Get encrypted room keys for current user |
| `POST` | `/api/rooms/{room_id}/keys` | Upload encrypted room keys (others' keys require op/owner/admin) |

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/rooms/routes.py` | Room CRUD, member management, key endpoints, folder CRUD |
| `backend/skrib/rooms/services.py` | Room logic, DM handling, member operations |
| `backend/skrib/rooms/schemas.py` | Pydantic models for room operations |
| `backend/skrib/room_folders/services.py` | Folder nesting logic, depth validation, circular ref detection |
| `backend/skrib/permissions.py` | Room access and permission checks (membership enforcement) |
| `backend/skrib/ws/handlers.py` | WebSocket event routing for room actions |
| `backend/skrib/ws/manager.py` | Connection tracking, room subscriptions, user-scoped broadcasts |
| `frontend/src/app.js` | Sidebar rendering, folder UI, room switching, drag-and-drop |
| `frontend/src/room-settings.js` | Room settings page (topic, visibility, members, join requests) |
