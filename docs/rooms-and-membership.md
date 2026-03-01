# Rooms and Membership

Rooms are the primary organizational unit in Skrib. All room behavior is defined by plugins — a room's `room_type` determines which plugin handles its WebSocket actions, rendering, and storage.

## Room Model

| Field | Description |
|---|---|
| `room_id` | Primary key. DMs use format `dm\|user1\|user2` (sorted alphabetically) |
| `room_type` | Plugin-registered type (e.g., `chat`, `todo`) |
| `topic` | Optional room topic/description |
| `created_by` | Username of the room creator |
| `is_dm` | Boolean flag for direct messages |
| `folder_id` | Optional reference to a room folder |
| `sort_position` | Position within a folder for ordering |
| `created_at` | Creation timestamp |

Room creation validates `room_type` against currently enabled plugin room types. Attempting to create a room with an unregistered type is rejected.

## Direct Messages

DMs are regular rooms with `is_dm = true` and a deterministic ID format: `dm|alice|bob` (usernames sorted alphabetically, pipe-separated). This ensures only one DM room exists between any two users.

There is no functional distinction between DMs and rooms at the data model level — the difference is in UI treatment (DMs are listed separately in the sidebar).

## Membership

The `room_users` table tracks membership:

| Field | Description |
|---|---|
| `room_id` + `username` | Composite primary key |
| `room_role` | `owner`, `op`, `voice`, or `member` |
| `last_read_message_id` | Last message the user has read (for unread counts) |
| `notify_level` | `all`, `mentions`, or `muted` |
| `joined_at` | When the user joined |

### Roles

| Role | Capabilities |
|---|---|
| `owner` | Full room control: settings, topic, members, delete. Assigned to room creator. |
| `op` | Manage members, set topic, kick users |
| `voice` | Standard participation (reserved for future use) |
| `member` | Read and send messages |

Global roles (`admin`, `moderator`) can override room roles for moderation purposes.

### Adding Members

Members are added via:

- REST API: `POST /rooms/{room_id}/members`
- Slash command: `/invite <username>` (also distributes encryption keys)
- Room creation (creator is auto-added as `owner`)

When a member is invited via `/invite`, the inviter:
1. Adds them to the room via the API
2. Fetches their RSA public key
3. Encrypts all room key epochs for the new member
4. Uploads the encrypted keys to the server

### Removing Members

- REST API: `DELETE /rooms/{room_id}/members/{username}`
- Slash command: `/kick <username>` (requires room op or global moderator)
- Self-removal: `/leave` or `/part`

### Notification Levels

Per-room notification preference:

| Level | Behavior |
|---|---|
| `all` | Notify on every new message |
| `mentions` | Notify only on @mentions (reserved for future implementation) |
| `muted` | No notifications |

### Unread Counts

Unread tracking is delegated to room-type plugins via the callback system:

1. Client marks a room as read: `POST /rooms/{room_id}/read` with `last_read_message_id`
2. Unread count computed by the plugin callback (`/unread-count` or `/unread-counts-batch`)
3. Sidebar displays unread badge per room (capped at `99+`)

## Room Folders

Rooms can be organized into nestable folders.

### Folder Model

| Field | Description |
|---|---|
| `folder_id` | Primary key (UUID) |
| `name` | Display name |
| `parent_folder_id` | Reference to parent folder (adjacency list) |
| `position` | Sort position within parent |
| `created_at` | Creation timestamp |

### Constraints

- Maximum nesting depth: 5 levels
- Folder mutations (create, rename, move, delete) require `admin` or `moderator` role
- Deleting a folder moves its rooms and sub-folders to the root level

### Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/room-folders` | List all folders (tree structure) |
| `POST` | `/api/room-folders` | Create a folder |
| `PATCH` | `/api/room-folders/{folder_id}` | Rename or move a folder |
| `DELETE` | `/api/room-folders/{folder_id}` | Delete a folder |
| `POST` | `/api/room-folders/reorder` | Batch reorder rooms and folders |

### Frontend

- SortableJS for drag-and-drop reordering of rooms within and between folders
- Collapsed state stored per-folder in `localStorage`
- Unread badges on folders aggregate counts recursively across all nested rooms
- `room:folders_updated` WebSocket event triggers sidebar refresh for all connected users

## Room Deletion

Room deletion is a **hard delete**. When a room is deleted:

1. Room record removed from `rooms` table
2. All memberships removed from `room_users`
3. All encryption keys removed from `room_keys`
4. Plugin lifecycle hook `on_room_deleted(room_id)` fires — plugins clean up their own data (messages, reactions, etc.)
5. `room:deleted` event broadcast to all room members

## Room Settings

Each room has a settings page (`/room-settings.html?room={room_id}`) accessible to room ops and owners:

- View and edit room topic
- Manage member list (add, remove, change roles)
- View room metadata (type, creator, creation date)
- Delete room (owner or admin only)

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/rooms` | List rooms where the user is a member |
| `POST` | `/api/rooms` | Create a new room |
| `GET` | `/api/rooms/{room_id}` | Get room details |
| `PATCH` | `/api/rooms/{room_id}` | Update room metadata |
| `DELETE` | `/api/rooms/{room_id}` | Delete a room |
| `GET` | `/api/rooms/{room_id}/members` | List room members |
| `POST` | `/api/rooms/{room_id}/members` | Add a member |
| `DELETE` | `/api/rooms/{room_id}/members/{username}` | Remove a member |
| `POST` | `/api/rooms/{room_id}/read` | Mark room as read |
| `GET` | `/api/rooms/{room_id}/keys` | Get encrypted room keys for current user |
| `POST` | `/api/rooms/{room_id}/keys` | Upload encrypted room keys |

## Implementation Files

| File | Role |
|---|---|
| `backend/skrib/rooms/routes.py` | Room CRUD, member management, key endpoints |
| `backend/skrib/rooms/services.py` | Room logic, DM handling, member operations |
| `backend/skrib/rooms/schemas.py` | Pydantic models for room operations |
| `backend/skrib/room_folders/routes.py` | Folder CRUD and reorder endpoints |
| `backend/skrib/room_folders/services.py` | Folder nesting logic, depth validation |
| `backend/skrib/permissions.py` | Room permission checks |
| `frontend/src/app.js` | Sidebar rendering, folder UI, room switching |
| `frontend/src/room-settings.js` | Room settings page |
