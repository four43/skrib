"""Chat room message storage and retrieval."""
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from mini_chat.database import get_db


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
        timestamp = datetime.now().isoformat()

        with get_db() as conn:
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

    def get_messages(self, since: int = 0) -> List[Dict]:
        """Get messages since a certain ID."""
        with get_db() as conn:
            cursor = conn.execute('''
                SELECT id, username, content, content_type, key_epoch, timestamp
                FROM messages
                WHERE room_id = ? AND id > ?
                ORDER BY id
            ''', (self.room_id, since))

            messages = []
            for row in cursor:
                messages.append({
                    'id': row['id'],
                    'username': row['username'],
                    'content': row['content'],
                    'content_type': row['content_type'],
                    'key_epoch': row['key_epoch'],
                    'timestamp': row['timestamp']
                })

            return messages
