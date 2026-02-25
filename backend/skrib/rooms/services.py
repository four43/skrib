"""Business logic for rooms."""
import re
from datetime import datetime
from typing import List, Dict, Optional
import threading

from ..database import get_db

# In-memory room registry: {room_id: room_type}
ROOMS: Dict[str, str] = {}
ROOMS_LOCK = threading.Lock()

CHANNEL_NAME_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')


def is_dm(room_id: str) -> bool:
    """Check if a room is a DM by its room_id prefix."""
    return room_id.startswith('dm|')


def validate_channel_name(name: str) -> bool:
    """Validate a channel name: lowercase alphanumeric and hyphens only."""
    return bool(CHANNEL_NAME_RE.match(name))


def load_rooms_from_db():
    """Load existing rooms from database."""
    with get_db() as conn:
        cursor = conn.execute('SELECT room_id, room_type FROM rooms WHERE deleted = 0')
        with ROOMS_LOCK:
            for row in cursor:
                ROOMS[row['room_id']] = row['room_type']

        conn.commit()


def get_user_rooms(username: str) -> List[Dict]:
    """Get rooms visible to a user: all rooms they're a member of."""
    unread_counts = get_unread_counts(username)

    with get_db() as conn:
        cursor = conn.execute('''
            SELECT r.room_id, r.room_type, r.topic, rm.notify_level,
                   r.folder_id, r.sort_position
            FROM rooms r
            JOIN room_users rm ON r.room_id = rm.room_id
            WHERE r.deleted = 0 AND rm.username = ?
        ''', (username,))
        rooms = []
        for row in cursor:
            room_id = row['room_id']
            if is_dm(room_id):
                members = get_room_members(room_id)
                display_name = dm_display_name(members, username)
            else:
                members = []
                display_name = f"#{room_id}"
            rooms.append({
                'room_id': room_id,
                'room_type': row['room_type'],
                'display_name': display_name,
                'topic': row['topic'] or '',
                'members': members,
                'unread_count': unread_counts.get(room_id, 0),
                'notify_level': row['notify_level'],
                'is_dm': is_dm(room_id),
                'folder_id': row['folder_id'],
                'sort_position': row['sort_position'] or 0,
            })

        return rooms


def get_room_members(room_id: str) -> List[str]:
    """Get members of a room."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username FROM room_users WHERE room_id = ?',
            (room_id,)
        )
        return [row['username'] for row in cursor]


def get_all_rooms() -> List[str]:
    """Get list of all room IDs."""
    with ROOMS_LOCK:
        return list(ROOMS.keys())


def create_room(room_id: str, room_type: str = 'chat', created_by: str = None) -> bool:
    """Create a new room."""
    with ROOMS_LOCK:
        if room_id in ROOMS:
            return False
        ROOMS[room_id] = room_type

    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO rooms (room_id, room_type, created_at, created_by) VALUES (?, ?, ?, ?)',
            (room_id, room_type, now, created_by)
        )
        conn.commit()
    return True


def dm_display_name(members: List[str], viewer: str) -> str:
    """Build a display name for a DM from the perspective of *viewer*."""
    others = [m for m in members if m != viewer]
    if not others:
        return viewer
    return ", ".join(others)


def create_or_get_dm(creator: str, other_users: List[str], room_type: str = 'chat') -> Dict:
    """Create or return existing DM room among a set of users (including the creator)."""
    all_users = sorted(set([creator] + other_users))
    room_id = "dm|" + "|".join(all_users)

    with ROOMS_LOCK:
        if room_id in ROOMS:
            members = get_room_members(room_id)
            return {
                'room_id': room_id,
                'room_type': room_type,
                'display_name': dm_display_name(members, creator),
                'members': members,
                'is_dm': True,
            }

    # Create new DM room
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO rooms (room_id, room_type, created_at) VALUES (?, ?, ?)',
            (room_id, room_type, now)
        )
        for user in all_users:
            conn.execute(
                'INSERT OR IGNORE INTO room_users (room_id, username, room_role, joined_at) VALUES (?, ?, ?, ?)',
                (room_id, user, 'member', now)
            )
        conn.commit()

    with ROOMS_LOCK:
        ROOMS[room_id] = room_type

    return {
        'room_id': room_id,
        'room_type': room_type,
        'display_name': dm_display_name(all_users, creator),
        'members': all_users,
        'is_dm': True,
    }


def get_room_type(room_id: str) -> Optional[str]:
    """Get the type of a room."""
    with ROOMS_LOCK:
        return ROOMS.get(room_id)


def delete_room(room_id: str, deleted_by: str) -> bool:
    """Soft-delete a room."""
    with ROOMS_LOCK:
        if room_id not in ROOMS:
            return False
        del ROOMS[room_id]

    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            'UPDATE rooms SET deleted = 1, deleted_at = ?, deleted_by = ? WHERE room_id = ?',
            (now, deleted_by, room_id)
        )
        conn.commit()
    return True


def room_exists(room_id: str) -> bool:
    """Check if a room exists."""
    with ROOMS_LOCK:
        return room_id in ROOMS


def ensure_room_exists(room_id: str):
    """Ensure a room exists, create if it doesn't."""
    with ROOMS_LOCK:
        if room_id not in ROOMS:
            ROOMS[room_id] = 'chat'


def add_room_member(room_id: str, username: str, room_role: str = 'member') -> Dict:
    """Add a user as a member of a room.

    Returns dict with 'status': 'ok', 'already_member', 'user_not_found', or 'room_not_found'.
    """
    if not room_exists(room_id):
        return {'status': 'room_not_found'}

    now = datetime.now().isoformat()
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username FROM users WHERE username = ?', (username,)
        )
        if not cursor.fetchone():
            return {'status': 'user_not_found'}

        cursor = conn.execute(
            'SELECT 1 FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        if cursor.fetchone():
            return {'status': 'already_member'}

        conn.execute(
            'INSERT INTO room_users (room_id, username, room_role, joined_at) VALUES (?, ?, ?, ?)',
            (room_id, username, room_role, now),
        )
        conn.commit()

    return {'status': 'ok'}


def remove_room_member(room_id: str, username: str) -> Dict:
    """Remove a user from a room.

    Returns dict with 'status': 'ok', 'not_member', or 'room_not_found'.
    """
    if not room_exists(room_id):
        return {'status': 'room_not_found'}

    with get_db() as conn:
        cursor = conn.execute(
            'SELECT 1 FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        if not cursor.fetchone():
            return {'status': 'not_member'}

        conn.execute(
            'DELETE FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        conn.commit()

    return {'status': 'ok'}


def store_room_key(room_id: str, username: str, key_epoch: int, encrypted_key: str):
    """Store an encrypted room key for a user at a given epoch."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO room_keys (room_id, key_epoch, username, encrypted_key, created_at)
            VALUES (?, ?, ?, ?, ?)
        ''', (room_id, key_epoch, username, encrypted_key, now))
        conn.commit()


def get_room_keys(room_id: str, username: str) -> List[Dict]:
    """Get all encrypted room keys for a user across all epochs."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT key_epoch, encrypted_key
            FROM room_keys
            WHERE room_id = ? AND username = ?
            ORDER BY key_epoch
        ''', (room_id, username))
        return [
            {'key_epoch': row['key_epoch'], 'encrypted_key': row['encrypted_key']}
            for row in cursor
        ]


def set_notify_level(room_id: str, username: str, level: str):
    """Set the notification level for a user in a room."""
    with get_db() as conn:
        conn.execute('''
            UPDATE room_users SET notify_level = ?
            WHERE room_id = ? AND username = ?
        ''', (level, room_id, username))
        conn.commit()


def get_notify_level(room_id: str, username: str) -> str:
    """Get the notification level for a user in a room."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT notify_level FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        row = cursor.fetchone()
        return row['notify_level'] if row else 'all'


def mark_room_read(room_id: str, username: str, message_id: int):
    """Update the user's last-read position in a room."""
    with get_db() as conn:
        conn.execute('''
            UPDATE room_users
            SET last_read_message_id = MAX(last_read_message_id, ?)
            WHERE room_id = ? AND username = ?
        ''', (message_id, room_id, username))
        conn.commit()


def get_room_role(room_id: str, username: str) -> Optional[str]:
    """Get a user's role in a room. Returns None if not a member."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT room_role FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        row = cursor.fetchone()
        return row['room_role'] if row else None


def set_topic(room_id: str, topic: str) -> bool:
    """Set a room's topic. Returns False if room not found."""
    if not room_exists(room_id):
        return False
    with get_db() as conn:
        conn.execute(
            'UPDATE rooms SET topic = ? WHERE room_id = ?',
            (topic, room_id),
        )
        conn.commit()
    return True


def get_room_info(room_id: str) -> Optional[Dict]:
    """Get full room details including topic and members with roles."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT room_id, room_type, topic, created_by FROM rooms WHERE room_id = ? AND deleted = 0',
            (room_id,),
        )
        room = cursor.fetchone()
        if not room:
            return None

        cursor = conn.execute('''
            SELECT
                ru.username,
                ru.room_role,
                ru.joined_at,
                u.nickname,
                u.color
            FROM room_users ru
            LEFT JOIN users u ON ru.username = u.username
            WHERE ru.room_id = ?
        ''', (room_id,))
        members = [
            {
                'username': row['username'],
                'room_role': row['room_role'],
                'joined_at': row['joined_at'],
                'nickname': row['nickname'],
                'color': row['color'],
            }
            for row in cursor
        ]

    return {
        'room_id': room['room_id'],
        'room_type': room['room_type'],
        'topic': room['topic'],
        'created_by': room['created_by'],
        'members': members,
        'is_dm': is_dm(room['room_id']),
    }


def set_room_role(room_id: str, target_username: str, role: str) -> Dict:
    """Set a user's role in a room.

    Returns dict with 'status': 'ok', 'not_member', or 'room_not_found'.
    """
    if not room_exists(room_id):
        return {'status': 'room_not_found'}

    with get_db() as conn:
        cursor = conn.execute(
            'SELECT 1 FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, target_username),
        )
        if not cursor.fetchone():
            return {'status': 'not_member'}

        conn.execute(
            'UPDATE room_users SET room_role = ? WHERE room_id = ? AND username = ?',
            (role, room_id, target_username),
        )
        conn.commit()

    return {'status': 'ok'}


def get_unread_counts(username: str) -> Dict[str, int]:
    """Get unread message counts for all rooms the user is a member of.

    Queries room read positions from core DB, then delegates to the
    room-type plugin to count unread messages in its own DB.
    """
    # Get read positions from core DB
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT rm.room_id, rm.last_read_message_id, r.room_type
            FROM room_users rm
            JOIN rooms r ON rm.room_id = r.room_id AND r.deleted = 0
            WHERE rm.username = ?
        ''', (username,))
        rooms = [
            {'room_id': row['room_id'], 'last_read': row['last_read_message_id'], 'room_type': row['room_type']}
            for row in cursor
        ]

    if not rooms:
        return {}

    # Group by room type and delegate to plugins
    from ..plugins import registry
    by_type: Dict[str, Dict[str, int]] = {}
    for room in rooms:
        rt = room['room_type']
        if rt not in by_type:
            by_type[rt] = {}
        by_type[rt][room['room_id']] = room['last_read'] or 0

    result = {}
    for room_type, positions in by_type.items():
        plugin = registry.get_plugin_for_room_type(room_type)
        if plugin and hasattr(plugin, 'get_unread_counts_batch'):
            counts = plugin.get_unread_counts_batch(positions)
            result.update(counts)
        else:
            # No plugin or plugin doesn't support unread counts
            for room_id in positions:
                result[room_id] = 0

    return result


def get_unread_count_for_room(room_id: str, username: str) -> int:
    """Get unread message count for a specific room and user.

    Queries read position from core DB, then delegates to the
    room-type plugin to count unread messages in its own DB.
    """
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT last_read_message_id FROM room_users WHERE room_id = ? AND username = ?',
            (room_id, username)
        )
        row = cursor.fetchone()
        if not row:
            return 0
        last_read = row['last_read_message_id'] or 0

    # Get room type and delegate to plugin
    room_type = get_room_type(room_id)
    if not room_type:
        return 0

    from ..plugins import registry
    plugin = registry.get_plugin_for_room_type(room_type)
    if plugin and hasattr(plugin, 'get_unread_count'):
        return plugin.get_unread_count(room_id, last_read)

    return 0
