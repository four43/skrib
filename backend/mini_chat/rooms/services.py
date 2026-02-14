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


def validate_channel_name(name: str) -> bool:
    """Validate a channel name: lowercase alphanumeric and hyphens only."""
    return bool(CHANNEL_NAME_RE.match(name))


class ChatRoom:
    """Chat room that uses SQLite for message storage."""

    def __init__(self, room_id: str):
        self.room_id = room_id

    def add_message(self, username: str, message: str) -> Dict:
        """Add a message to the room."""
        timestamp = datetime.now().isoformat()

        with get_db() as conn:
            conn.execute('''
                INSERT INTO messages (room_id, username, message, timestamp)
                VALUES (?, ?, ?, ?)
            ''', (self.room_id, username, message, timestamp))
            conn.commit()

        return {
            'username': username,
            'message': message,
            'timestamp': timestamp
        }

    def get_messages(self, since: int = 0) -> List[Dict]:
        """Get messages since a certain ID."""
        with get_db() as conn:
            cursor = conn.execute('''
                SELECT id, username, message, timestamp
                FROM messages
                WHERE room_id = ? AND id > ?
                ORDER BY id
            ''', (self.room_id, since))

            messages = []
            for row in cursor:
                messages.append({
                    'id': row['id'],
                    'username': row['username'],
                    'message': row['message'],
                    'timestamp': row['timestamp']
                })

            return messages


def load_rooms_from_db():
    """Load existing rooms from database."""
    with get_db() as conn:
        cursor = conn.execute('SELECT room_id, room_type FROM rooms WHERE deleted = 0')
        with ROOMS_LOCK:
            for row in cursor:
                ROOMS[row['room_id']] = row['room_type']

        # Also pick up any rooms that exist in messages but not in the rooms table
        cursor = conn.execute('''
            SELECT DISTINCT m.room_id FROM messages m
            LEFT JOIN rooms r ON m.room_id = r.room_id
            WHERE r.room_id IS NULL
        ''')
        now = datetime.now().isoformat()
        for row in cursor:
            room_id = row['room_id']
            conn.execute(
                'INSERT INTO rooms (room_id, room_type, created_at) VALUES (?, ?, ?)',
                (room_id, 'channel', now)
            )
            with ROOMS_LOCK:
                ROOMS[room_id] = 'channel'
        conn.commit()


def get_user_rooms(username: str) -> List[Dict]:
    """Get rooms visible to a user: channels and DMs they're a member of."""
    with get_db() as conn:
        # Get channels where user is a member
        cursor = conn.execute('''
            SELECT r.room_id, r.room_type
            FROM rooms r
            JOIN room_members rm ON r.room_id = rm.room_id
            WHERE r.deleted = 0 AND r.room_type = 'channel' AND rm.username = ?
        ''', (username,))
        rooms = []
        for row in cursor:
            rooms.append({
                'room_id': row['room_id'],
                'room_type': 'channel',
                'display_name': f"#{row['room_id']}",
                'members': [],
            })

        # Get DMs where user is a member
        cursor = conn.execute('''
            SELECT r.room_id, r.room_type
            FROM rooms r
            JOIN room_members rm ON r.room_id = rm.room_id
            WHERE r.deleted = 0 AND r.room_type = 'dm' AND rm.username = ?
        ''', (username,))

        for row in cursor:
            room_id = row['room_id']
            members = get_room_members(room_id)
            rooms.append({
                'room_id': room_id,
                'room_type': 'dm',
                'display_name': dm_display_name(members, username),
                'members': members,
            })

        return rooms


def get_room_members(room_id: str) -> List[str]:
    """Get members of a room."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username FROM room_members WHERE room_id = ?',
            (room_id,)
        )
        return [row['username'] for row in cursor]


def get_all_rooms() -> List[str]:
    """Get list of all room IDs."""
    with ROOMS_LOCK:
        return list(ROOMS.keys())


def create_room(room_id: str, room_type: str = 'channel') -> bool:
    """Create a new room."""
    with ROOMS_LOCK:
        if room_id in ROOMS:
            return False
        ROOMS[room_id] = room_type

    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO rooms (room_id, room_type, created_at) VALUES (?, ?, ?)',
            (room_id, room_type, now)
        )
        conn.commit()
    return True


def dm_display_name(members: List[str], viewer: str) -> str:
    """Build a display name for a DM from the perspective of *viewer*."""
    others = [m for m in members if m != viewer]
    if not others:
        return viewer
    return ", ".join(others)


def create_or_get_dm(creator: str, other_users: List[str]) -> Dict:
    """Create or return existing DM room among a set of users (including the creator)."""
    all_users = sorted(set([creator] + other_users))
    room_id = "dm|" + "|".join(all_users)

    with ROOMS_LOCK:
        if room_id in ROOMS:
            members = get_room_members(room_id)
            return {
                'room_id': room_id,
                'room_type': 'dm',
                'display_name': dm_display_name(members, creator),
                'members': members,
            }

    # Create new DM room
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO rooms (room_id, room_type, created_at) VALUES (?, ?, ?)',
            (room_id, 'dm', now)
        )
        for user in all_users:
            conn.execute(
                'INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?, ?)',
                (room_id, user)
            )
        conn.commit()

    with ROOMS_LOCK:
        ROOMS[room_id] = 'dm'

    return {
        'room_id': room_id,
        'room_type': 'dm',
        'display_name': dm_display_name(all_users, creator),
        'members': all_users,
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
            ROOMS[room_id] = 'channel'


def add_room_member(room_id: str, username: str) -> Dict:
    """Add a user as a member of a room.

    Returns dict with 'status': 'ok', 'already_member', 'user_not_found', or 'room_not_found'.
    """
    if not room_exists(room_id):
        return {'status': 'room_not_found'}

    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username FROM users WHERE username = ?', (username,)
        )
        if not cursor.fetchone():
            return {'status': 'user_not_found'}

        cursor = conn.execute(
            'SELECT 1 FROM room_members WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        if cursor.fetchone():
            return {'status': 'already_member'}

        conn.execute(
            'INSERT INTO room_members (room_id, username) VALUES (?, ?)',
            (room_id, username),
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
            'SELECT 1 FROM room_members WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        if not cursor.fetchone():
            return {'status': 'not_member'}

        conn.execute(
            'DELETE FROM room_members WHERE room_id = ? AND username = ?',
            (room_id, username),
        )
        conn.commit()

    return {'status': 'ok'}


def store_room_key(room_id: str, username: str, key_epoch: int, encrypted_key: str):
    """Store an encrypted room key for a user at a given epoch."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            'INSERT OR REPLACE INTO room_keys (room_id, username, key_epoch, encrypted_key, created_at) VALUES (?, ?, ?, ?, ?)',
            (room_id, username, key_epoch, encrypted_key, now),
        )
        conn.commit()


def get_room_keys(room_id: str, username: str) -> List[Dict]:
    """Get all encrypted room keys for a user across all epochs."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT key_epoch, encrypted_key FROM room_keys WHERE room_id = ? AND username = ? ORDER BY key_epoch',
            (room_id, username),
        )
        return [{'key_epoch': row['key_epoch'], 'encrypted_key': row['encrypted_key']} for row in cursor]
