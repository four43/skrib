PR #1: UUID Migration for Users and Rooms
Context
Skrib currently uses username as the user primary key and human-readable strings as room_id (e.g., "general", "dm|chat|alice|bob"). These leak identity and relationship information in the database. This PR switches both to opaque UUIDs, laying the groundwork for a follow-up PR that encrypts usernames, room names, and other metadata with a shared "server key."

This PR does NOT add encryption. It only changes the identifier scheme. Username stays in the DB as plaintext for now.

Since the project is early development, we'll reset the database (delete data/*) rather than migrate.

Schema Changes
File: database.py

Users table

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,          -- UUID, generated server-side
    username TEXT NOT NULL UNIQUE,     -- plaintext for now, encrypted in PR #2
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    role TEXT NOT NULL DEFAULT 'user',
    approval_code TEXT,
    encryption_public_key TEXT,
    color TEXT NOT NULL DEFAULT '#1976d2',
    nickname TEXT,
    theme_color TEXT,
    theme_name TEXT,
    color_scheme TEXT,
    encrypted_private_key TEXT,
    avatar_data BLOB,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT                   -- changes to user_id reference
);
Rooms table

CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,          -- UUID now, not human-readable
    name TEXT NOT NULL DEFAULT '',     -- NEW: room display name (plaintext now, encrypted in PR #2)
    room_type TEXT NOT NULL DEFAULT 'chat',
    topic TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT,                   -- user_id reference
    deleted BOOLEAN NOT NULL DEFAULT 0,
    deleted_at TEXT,
    deleted_by TEXT                    -- user_id reference
);
Room users table

CREATE TABLE IF NOT EXISTS room_users (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,             -- was username
    room_role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    notify_level TEXT NOT NULL DEFAULT 'all',
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
Room keys table

CREATE TABLE IF NOT EXISTS room_keys (
    room_id TEXT NOT NULL,
    key_epoch INTEGER NOT NULL,
    user_id TEXT NOT NULL,             -- was username
    encrypted_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, key_epoch, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
Invite tokens table

CREATE TABLE IF NOT EXISTS invite_tokens (
    token TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,          -- user_id reference
    created_at TEXT NOT NULL,
    used_by TEXT,                      -- user_id reference
    used_at TEXT,
    FOREIGN KEY (created_by) REFERENCES users(user_id)
);
Challenges table — no change (temporary data)
Global Pattern: What Replaces What
Old pattern	New pattern	Notes
username as PK/FK	user_id (UUID)	All foreign keys, session tokens, WS routing
username in API paths	user_id in paths	/users/{user_id}, /rooms/{room_id}/members/{user_id}
username in session token	user_id in token	create_session_token(user_id)
currentUsername in frontend	currentUserId + currentUsername	Keep username for display, use user_id for API calls
Room room_id = name	Room room_id = UUID	Add name field for display
DM room_id = dm|type|user1|user2	DM room_id = UUID	Server maintains membership, no ID-leaked participants
is_dm(room_id) checks prefix	is_dm flag or check room_type + member count	No more string parsing
WS user_connections[username]	user_connections[user_id]	Index by UUID
WS room_connections[room_id]	No change needed	room_id is already the key, just now a UUID
Backend File Changes
Core
database.py — Schema changes above. Add import uuid. Generate user_id = str(uuid.uuid4()) in create functions.

config.py — No changes.

dependencies.py — All functions that extract/return username from tokens change to extract/return user_id. Functions:

get_username_from_credentials() → get_user_id_from_credentials()
get_username_from_token() → get_user_id_from_token()
require_auth() → returns user_id instead of username
require_admin(), require_moderator() → check role by user_id
verify_token() (WS) → returns user_id
Auth module
auth/services.py

create_pending_user() — generates user_id = str(uuid.uuid4()), inserts with user_id as PK
create_session_token(user_id) — encode user_id in token instead of username
verify_session_token() — extract user_id from token
get_user_by_credential() — return user_id alongside username/role
Registration response needs to include user_id
auth/routes.py

complete_registration — return user_id in response
complete_login — return user_id in response alongside username
check_session — return user_id in response
store_encryption_key — use user_id from auth dep
get_encryption_key/{target} — path param becomes user_id (or keep username for now since it's a lookup)
auth/schemas.py

Add user_id: str to RegistrationCompleteResponse, LoginCompleteResponse, SessionResponse
EncryptionKeyResponse — add user_id field
Rooms module
rooms/services.py

create_room() — generate UUID room_id, accept name parameter
create_or_get_dm() — generate UUID instead of dm|type|user1|user2. Need new logic to find existing DM by member set rather than by room_id string. Add helper: query room_users for rooms where all target user_ids are members and room_type matches.
get_user_rooms(user_id) — filter by user_id
is_dm() — can't check prefix anymore. Check room_type + member count, or add is_dm BOOLEAN column to rooms table.
add_room_member(room_id, user_id), remove_room_member() — use user_id
store_room_key(room_id, user_id, ...), get_room_keys(room_id, user_id) — use user_id
All other functions — swap username → user_id in SQL queries and parameters
rooms/routes.py

All path params: {room_id} stays (now UUID), {target_username} → {target_user_id}
create_room — accept name in request body, server generates room_id UUID
create_dm — accept user_ids list instead of usernames list
Room responses include name field
Member operations use user_id
rooms/schemas.py

Add user_id fields alongside or replacing username fields
CreateRoomRequest — remove room_id (server generates), add name
CreateDMRequest — usernames → user_ids
RoomResponse — add name field
AddMemberRequest — username → user_id
StoreRoomKeyRequest — username → user_id
MessageResponse — add user_id, keep username for display
Users module
users/services.py

All functions: username param → user_id param in SQL queries
get_user_preferences(user_id), update_user_preferences(user_id, ...)
approve_user() — look up by approval_code, update status
get_all_user_preferences() — return user_id as key (or both user_id and username)
set_user_role(user_id, role), revoke_user_access(user_id)
users/routes.py

/{target_username} → /{target_user_id} in all path params
/{username}/avatar → /{user_id}/avatar
Response models include both user_id and username for display
users/schemas.py

Add user_id: str to all user-related schemas
Keep username: str for display purposes
users/avatar.py

generate_identicon(user_id) — hash user_id instead of username (deterministic, unique)
get_or_generate_avatar(user_id) — look up by user_id
WebSocket module
ws/manager.py

user_connections keyed by user_id instead of username
connect(ws, user_id), disconnect(ws), notify_user(user_id), broadcast_all(user_id)
dispatch(ws, user_id, raw) — pass user_id to handlers
ws/handlers.py

handle_system(bus, ws, user_id, msg), handle_room(bus, ws, user_id, msg)
check_room_access(room_id, user_id) — query by user_id
ws/routes.py

Extract user_id from token (via updated verify_token)
Messages module
messages/services.py

Search query uses user_id for sender filtering
Message results include both user_id and username
messages/routes.py

Query params: username → user_id for filtering
messages/schemas.py

MessageResponse — add user_id, keep username
Plugins
four43.room-type-chat

backend/plugin.py — messages table: add user_id column alongside username. Handler receives user_id.
backend/routes.py — message endpoints use user_id
backend/services.py — queries use user_id
frontend/plugin.js — message rendering uses user_id for lookups, username for display
Other plugins (web-push, message-reactions, chat-typing, room-type-todo):

Same pattern: replace username with user_id in routing/storage, keep username in display/payloads
Frontend File Changes
Global pattern
Store both user_id and username in localStorage
Use user_id for all API calls and WebSocket messages
Use username for display only
Add currentUserId alongside currentUsername
app.js
Line 14-15: Add let currentUserId = null;
Line 22-28: userColors, userNicknames — key by user_id instead of username
checkSession() — store both user_id and username from session response
loadUserColors() — response keyed by user_id, but includes username for display
loadRooms() — rooms now have name field, DMs don't leak participants in room_id
createRoomItem() — use room.name or room.display_name for all rooms
Room creation (create channel) — send name instead of room_id to server
DM creation — send user_ids instead of usernames
/invite command — need to resolve username → user_id first. Add GET /users/by-username/{username} endpoint, or have the client use the user list (already loaded in userColors) to resolve
/nick command — PATCH /users/{currentUserId} instead of /{currentUsername}
WebSocket messages — send user_id in payloads
initRoomKey(), initDMRoomKey() — use user_id for key storage endpoints
All fetch(${API_URL}/rooms/${room_id}/members) calls — use user_id
Key maps roomKeys[room_id] — no change needed (room_id is just a different string)
register.js
After registration, store user_id from response (alongside username)
After auto-login, store both in localStorage
login.js
Store user_id from login response
Key recovery uses user_id for IndexedDB key storage (or keep username-based since it's local-only)
settings.js
currentUserId for API calls
Display currentUsername
room-settings.js
Member operations use user_id
Display uses username
admin.js
User management endpoints use user_id
Display uses username
crypto.js
storePrivateKey(userId, key) — IndexedDB key can use user_id or keep username (local only)
loadPrivateKey(userId) — same
New API Endpoint
GET /users/by-username/{username} — Resolve username to user_id. Needed for /invite <username> command. Returns { user_id, username } or 404. Auth required.

File: users/routes.py

DM Lookup Change
The biggest logic change is DM creation. Currently create_or_get_dm() constructs a deterministic room_id from sorted usernames. With UUIDs, we need to:

Query room_users for rooms where the exact set of user_ids are all members
Filter to rooms with room_type matching the DM type
If found, return existing room
If not found, create new room with UUID
File: rooms/services.py — create_or_get_dm() function (line 105-146)

Suggested approach:


def create_or_get_dm(creator_user_id, target_user_ids, room_type='chat'):
    all_user_ids = sorted(set([creator_user_id] + target_user_ids))
    # Find existing DM with exactly these members
    with get_db() as conn:
        placeholders = ','.join(['?'] * len(all_user_ids))
        cursor = conn.execute(f'''
            SELECT ru.room_id FROM room_users ru
            JOIN rooms r ON r.room_id = ru.room_id
            WHERE r.room_type = ? AND r.deleted = 0
              AND ru.user_id IN ({placeholders})
            GROUP BY ru.room_id
            HAVING COUNT(DISTINCT ru.user_id) = ?
        ''', [room_type] + all_user_ids + [len(all_user_ids)])
        # Also verify no EXTRA members in the room
        for row in cursor.fetchall():
            member_count = conn.execute(
                'SELECT COUNT(*) as c FROM room_users WHERE room_id = ?', (row['room_id'],)
            ).fetchone()['c']
            if member_count == len(all_user_ids):
                return row['room_id']
    # No existing DM found, create new one
    room_id = str(uuid.uuid4())
    create_room(room_id, name='', room_type=room_type, created_by=creator_user_id)
    for uid in all_user_ids:
        add_room_member(room_id, uid)
    return room_id
is_dm Detection
Add is_dm boolean to room responses, computed from member count + room context rather than room_id prefix.

Option A: Add is_dm BOOLEAN DEFAULT 0 column to rooms table.
Option B: Compute at query time based on member count ≤ 2 and no explicit name.

Recommendation: Option A — explicit column. Set it when creating DMs.

Implementation Order
Database schema — Update database.py with new schema
Auth core — auth/services.py, dependencies.py — session tokens use user_id
Auth routes/schemas — Return user_id in registration/login/session responses
Users module — services, routes, schemas — use user_id
Rooms module — services (including DM lookup rewrite), routes, schemas
WebSocket — manager.py, handlers.py, routes.py — route by user_id
Messages module — services, routes, schemas
Plugins — room-type-chat first (most complex), then others
Frontend app.js — core changes, room creation, DM creation, invite, nick
Frontend register.js, login.js — store user_id
Frontend settings.js, room-settings.js, admin.js — use user_id for API
Frontend plugin.js (chat plugin) — message rendering with user_id
Verification
Delete data/* to reset DB
Register first user → verify user_id UUID in DB, username in plaintext
Log in → verify session works, UI shows username
Create a channel → verify room_id is UUID, name field stores channel name
Create a DM → verify room_id is UUID (not dm|chat|...), participants correct
Send messages → verify user_id in messages table
/invite another user → verify room key distribution works with user_id
/nick command → works with user_id-based endpoint
/topic command → works
WebSocket reconnection → still works
Admin panel → user management works with user_id
Settings page → preferences work
Follow-up: PR #2 (Server Key Encryption)
After this PR, the next step adds:

Server key generation/distribution
Encrypt username → encrypted_username (+ username_hash for uniqueness)
Encrypt name, topic, nickname with server key
Server validates username during registration, hashes it, discards plaintext
