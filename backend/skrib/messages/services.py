"""Business logic for messages."""
from typing import List, Dict, Optional

from ..database import get_db


def search_messages(
    query: Optional[str] = None,
    room_id: Optional[str] = None,
    username: Optional[str] = None,
    limit: int = 100,
    offset: int = 0
) -> tuple[List[Dict], int]:
    """Search messages with optional filters."""
    with get_db() as conn:
        # Build the WHERE clause dynamically
        where_clauses = []
        params = []

        if query:
            where_clauses.append("content LIKE ?")
            params.append(f"%{query}%")

        if room_id:
            where_clauses.append("room_id = ?")
            params.append(room_id)

        if username:
            where_clauses.append("username = ?")
            params.append(username)

        where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

        # Get total count
        count_cursor = conn.execute(
            f"SELECT COUNT(*) as count FROM messages WHERE {where_sql}",
            params
        )
        total = count_cursor.fetchone()['count']

        # Get messages
        params.extend([limit, offset])
        cursor = conn.execute(f'''
            SELECT id, room_id, username, content, content_type, key_epoch, timestamp
            FROM messages
            WHERE {where_sql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        ''', params)

        messages = []
        for row in cursor:
            messages.append({
                'id': row['id'],
                'room_id': row['room_id'],
                'username': row['username'],
                'content': row['content'],
                'content_type': row['content_type'],
                'key_epoch': row['key_epoch'],
                'timestamp': row['timestamp']
            })

        return messages, total
