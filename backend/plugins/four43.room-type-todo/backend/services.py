"""Todo list item storage and retrieval.

Uses a plugin-scoped database provider instead of the core database.
The provider is set by the plugin during initialization.
"""
from datetime import datetime
from typing import Dict, List, Optional


_get_db = None


def init_db_provider(get_db_fn):
    """Set the database provider. Called by the plugin during init."""
    global _get_db
    _get_db = get_db_fn


class TodoList:
    """Handles todo item persistence for a single room."""

    def __init__(self, room_id: str):
        self.room_id = room_id

    def add_item(self, username: str, title: str, description: str = '') -> Dict:
        """Add a todo item to the room."""
        timestamp = datetime.now().isoformat()

        with _get_db() as conn:
            cursor = conn.execute('''
                INSERT INTO todo_items (room_id, username, title, description, done, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, ?, ?)
            ''', (self.room_id, username, title, description, timestamp, timestamp))
            item_id = cursor.lastrowid
            conn.commit()

        return {
            'id': item_id,
            'room_id': self.room_id,
            'username': username,
            'title': title,
            'description': description,
            'done': False,
            'created_at': timestamp,
            'updated_at': timestamp,
        }

    def update_item(self, item_id: int, title: Optional[str] = None,
                    description: Optional[str] = None, done: Optional[bool] = None) -> Optional[Dict]:
        """Update a todo item. Returns updated item or None if not found."""
        with _get_db() as conn:
            # Fetch current item
            cursor = conn.execute(
                'SELECT * FROM todo_items WHERE id = ? AND room_id = ?',
                (item_id, self.room_id)
            )
            row = cursor.fetchone()
            if not row:
                return None

            new_title = title if title is not None else row['title']
            new_description = description if description is not None else row['description']
            new_done = done if done is not None else bool(row['done'])
            updated_at = datetime.now().isoformat()

            conn.execute('''
                UPDATE todo_items
                SET title = ?, description = ?, done = ?, updated_at = ?
                WHERE id = ? AND room_id = ?
            ''', (new_title, new_description, int(new_done), updated_at, item_id, self.room_id))
            conn.commit()

        return {
            'id': item_id,
            'room_id': self.room_id,
            'username': row['username'],
            'title': new_title,
            'description': new_description,
            'done': new_done,
            'created_at': row['created_at'],
            'updated_at': updated_at,
        }

    def delete_item(self, item_id: int) -> bool:
        """Delete a todo item. Returns True if deleted."""
        with _get_db() as conn:
            cursor = conn.execute(
                'DELETE FROM todo_items WHERE id = ? AND room_id = ?',
                (item_id, self.room_id)
            )
            conn.commit()
            return cursor.rowcount > 0

    def get_items(self) -> List[Dict]:
        """Get all todo items for the room, ordered by creation time."""
        with _get_db() as conn:
            cursor = conn.execute('''
                SELECT id, room_id, username, title, description, done, created_at, updated_at
                FROM todo_items
                WHERE room_id = ?
                ORDER BY done ASC, id ASC
            ''', (self.room_id,))

            items = []
            for row in cursor:
                items.append({
                    'id': row['id'],
                    'room_id': row['room_id'],
                    'username': row['username'],
                    'title': row['title'],
                    'description': row['description'],
                    'done': bool(row['done']),
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at'],
                })

            return items

    def get_item(self, item_id: int) -> Optional[Dict]:
        """Get a single todo item by ID."""
        with _get_db() as conn:
            cursor = conn.execute(
                'SELECT * FROM todo_items WHERE id = ? AND room_id = ?',
                (item_id, self.room_id)
            )
            row = cursor.fetchone()
            if not row:
                return None

            return {
                'id': row['id'],
                'room_id': row['room_id'],
                'username': row['username'],
                'title': row['title'],
                'description': row['description'],
                'done': bool(row['done']),
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
            }
