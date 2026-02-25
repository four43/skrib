# Room Features

Rooms are the core collaboration unit in Skrib. There are two kinds: **channels** (named group rooms) and **DMs** (direct messages between specific users).

## Channels

Channels are named rooms anyone can be invited to. Names must be lowercase alphanumeric with hyphens (e.g. `general`, `project-alpha`). They display as `#general` in the sidebar.

**Creating a channel:** Any user can create a channel via `POST /rooms` with a `room_id` and `room_type` (defaults to `chat`). The creator becomes the room **owner**.

**Deleting a channel:** Only the room owner or a global admin can delete a channel (`DELETE /rooms/{room_id}`). Deletion is soft — the room is marked deleted and disappears from all members' room lists, but data is preserved.

## Direct Messages

DMs are created via `POST /rooms/dm` with a list of usernames. The room ID is deterministic (`dm|{type}|{sorted_usernames}`), so creating the same DM group twice returns the existing room. DMs support 2+ participants (group DMs).

DM display names show the other participants from the viewer's perspective (e.g. "alice, bob").

**DM restrictions:** You cannot leave, kick members from, set topics on, or assign folders to DMs. DMs are only created as certain
room type (e.g. `four43.room-type-chat`).

## Joining & Leaving

Users don't join rooms on their own — they are **invited** by an existing member.

### Inviting (joining)

- **Command:** `/invite <username>` in the chat input
- **API:** `POST /rooms/{room_id}/members` with `{ username }`
- **UI:** An "Invite" button in the `#members-panel` opens a modal to search and select users to invite
- Any current member can invite others
- The invited user gets a real-time notification via WebSocket and the room appears in their sidebar
- On invite, the inviter encrypts the room's E2E keys for the new member so they can decrypt message history

### Leaving

- **Command:** `/leave` or `/part`
- **API:** `DELETE /rooms/{room_id}/members/{username}`
- **UI:** A "Leave Room" option in the room settings menu
- Users can always remove themselves from channels
- The room disappears from their sidebar and they lose access
- **DMs cannot be left** — attempting to leave a DM returns an error

### Kicking

- **Command:** `/kick <username>`
- **API:** `DELETE /rooms/{room_id}/members/{target_username}`
- **UI:** A "Kick" option next to each member in the members panel (visible to ops+), with a confirmation prompt
- Requires **op**, global **admin**, or global **moderator** role
- Regular members cannot kick others
- Kicking is not allowed in DMs

## Roles & Permissions

Each channel member has a **room role**. Global roles (admin, moderator) override room roles.

| Role | Set topic | Invite | Kick | Change roles | Delete room |
|------|-----------|--------|------|--------------|-------------|
| **owner** | Yes | Yes | Yes | Yes | Yes |
| **op** | Yes | Yes | Yes | Yes | No |
| **voice** | No | Yes | No | No | No |
| **member** | No | Yes | No | No | No |

Global **admins** and **moderators** can perform any op-level action in any room. Admins can also delete any room.

**Changing roles:** Ops and above can promote/demote members via `PATCH /rooms/{room_id}/members/{username}` with `{ room_role }`. The `owner` role cannot be reassigned.

## Topic

Channels can have a topic (short description) displayed in the room header.

- **View:** `/topic` with no arguments
- **Set:** `/topic <text>`
- **API:** `PATCH /rooms/{room_id}` with `{ topic }`
- Requires op/owner or global admin/moderator
- Topic changes broadcast to all members viewing the room in real-time
- DMs do not support topics

## Notification Levels

Each user can set their notification preference per room:

| Level | Behavior |
|-------|----------|
| `all` (default) | Notified on every message |
| `mentions` | Only notified on @mentions |
| `muted` | No notifications |

Set via `PATCH /rooms/{room_id}/members/{username}` with `{ notify_level }`. Users can only change their own level.

## Unread Tracking

The server tracks a `last_read_message_id` per user per room. When a user views a room, the client sends `POST /rooms/{room_id}/read` to mark messages as read. Unread counts (shown as badges in the sidebar) are calculated from the difference.

## Room Folders

Admins and moderators can organize channels into a nestable folder hierarchy (up to 5 levels deep). Folders are collapsible in the sidebar. Rooms not assigned to a folder appear at the root level. DMs are never placed in folders.

## Commands Reference

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/invite <user>` | Invite a user to the current room |
| `/leave` or `/part` | Leave the current channel |
| `/kick <user>` | Remove a user from the room (op+) |
| `/topic [text]` | View or set the room topic (op+) |
| `/nick <name>` | Set your display nickname |
| `/nick clear` | Remove your nickname |
