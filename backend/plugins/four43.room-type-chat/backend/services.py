"""Chat room message storage and retrieval.

Uses a plugin-scoped database provider instead of the core database.
The provider is set by the plugin during initialization.
"""
from datetime import datetime, timezone
from typing import Dict, List, Optional


_get_db = None


def init_db_provider(get_db_fn):
    """Set the database provider. Called by the plugin during init."""
    global _get_db
    _get_db = get_db_fn


class ChatRoom:
    """Handles message persistence for a single room."""

    def __init__(self, room_id: str):
        self.room_id = room_id

    def add_message(
        self,
        username: str,
        content: str,
        content_type: str = 'text',
        key_epoch: Optional[int] = None
    ) -> Dict:
        """Add a message to the room."""
        timestamp = datetime.now(timezone.utc).isoformat()

        with _get_db() as conn:
            cursor = conn.execute('''
                INSERT INTO messages (room_id, username, content, content_type, key_epoch, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (self.room_id, username, content, content_type, key_epoch, timestamp))
            message_id = cursor.lastrowid
            conn.commit()

        return {
            'id': message_id,
            'username': username,
            'content': content,
            'content_type': content_type,
            'key_epoch': key_epoch,
            'timestamp': timestamp
        }

    def edit_message(
        self,
        message_id: int,
        username: str,
        content: str,
        content_type: str = 'text',
        key_epoch: Optional[int] = None,
    ) -> Dict:
        """Edit a message. Only the author can edit."""
        with _get_db() as conn:
            cursor = conn.execute(
                'SELECT id, username FROM messages WHERE id = ? AND room_id = ?',
                (message_id, self.room_id),
            )
            row = cursor.fetchone()
            if not row:
                raise ValueError("Message not found")
            if row['username'] != username:
                raise PermissionError("Can only edit your own messages")

            edited_at = datetime.now(timezone.utc).isoformat()
            conn.execute('''
                UPDATE messages
                SET content = ?, content_type = ?, key_epoch = ?, edited_at = ?
                WHERE id = ?
            ''', (content, content_type, key_epoch, edited_at, message_id))
            conn.commit()

        return {
            'message_id': message_id,
            'content': content,
            'content_type': content_type,
            'key_epoch': key_epoch,
            'edited_at': edited_at,
        }

    def delete_message(
        self,
        message_id: int,
        username: str,
        is_admin: bool = False,
    ) -> Dict:
        """Soft-delete a message. Author or admin can delete."""
        with _get_db() as conn:
            cursor = conn.execute(
                'SELECT id, username FROM messages WHERE id = ? AND room_id = ?',
                (message_id, self.room_id),
            )
            row = cursor.fetchone()
            if not row:
                raise ValueError("Message not found")
            if row['username'] != username and not is_admin:
                raise PermissionError("Can only delete your own messages")

            conn.execute(
                'UPDATE messages SET deleted = 1 WHERE id = ?',
                (message_id,),
            )
            conn.commit()

        return {'message_id': message_id, 'deleted': True}

    def get_messages(self, since: int = 0) -> List[Dict]:
        """Get messages since a certain ID."""
        with _get_db() as conn:
            cursor = conn.execute('''
                SELECT id, username, content, content_type, key_epoch, timestamp,
                       edited_at, deleted
                FROM messages
                WHERE room_id = ? AND id > ?
                ORDER BY id
            ''', (self.room_id, since))

            messages = []
            for row in cursor:
                msg = {
                    'id': row['id'],
                    'username': row['username'],
                    'content': '' if row['deleted'] else row['content'],
                    'content_type': row['content_type'],
                    'key_epoch': row['key_epoch'],
                    'timestamp': row['timestamp'],
                    'edited_at': row['edited_at'],
                    'deleted': bool(row['deleted']),
                }
                messages.append(msg)

            return messages
