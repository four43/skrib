"""Reactions plugin database operations.

Uses a plugin-scoped database provider instead of the core database.
The provider is set by the plugin during initialization.
"""
from datetime import datetime, timezone


_get_db = None


def init_db_provider(get_db_fn):
    """Set the database provider. Called by the plugin during init."""
    global _get_db
    _get_db = get_db_fn


def add_reaction(message_id: int, username: str, emoji: str) -> bool:
    """Add a reaction to a message.

    Returns:
        True if added, False if duplicate
    """
    with _get_db() as conn:
        try:
            conn.execute('''
                INSERT INTO message_reactions (message_id, username, emoji, created_at)
                VALUES (?, ?, ?, ?)
            ''', (message_id, username, emoji, datetime.now(timezone.utc).isoformat()))
            conn.commit()
            return True
        except Exception:
            # Duplicate reaction (primary key violation)
            return False


def remove_reaction(message_id: int, username: str, emoji: str):
    """Remove a reaction from a message."""
    with _get_db() as conn:
        conn.execute('''
            DELETE FROM message_reactions
            WHERE message_id = ? AND username = ? AND emoji = ?
        ''', (message_id, username, emoji))
        conn.commit()


def get_reactions(message_id: int) -> list:
    """Get all reactions for a message grouped by emoji.

    Returns:
        [{"emoji": "...", "usernames": [...], "count": N}, ...]
    """
    with _get_db() as conn:
        cursor = conn.execute('''
            SELECT emoji, username
            FROM message_reactions
            WHERE message_id = ?
            ORDER BY created_at
        ''', (message_id,))

        reactions = {}
        for row in cursor.fetchall():
            emoji = row['emoji']
            username = row['username']
            if emoji not in reactions:
                reactions[emoji] = {"emoji": emoji, "usernames": [], "count": 0}
            reactions[emoji]["usernames"].append(username)
            reactions[emoji]["count"] += 1

        return list(reactions.values())


def get_reactions_for_messages(message_ids: list) -> dict:
    """Get reactions for multiple messages efficiently.

    Returns:
        {message_id: [{"emoji": "...", "usernames": [...], "count": N}]}
    """
    if not message_ids:
        return {}

    with _get_db() as conn:
        placeholders = ','.join('?' * len(message_ids))
        cursor = conn.execute(f'''
            SELECT message_id, emoji, username
            FROM message_reactions
            WHERE message_id IN ({placeholders})
            ORDER BY message_id, created_at
        ''', message_ids)

        by_message = {}
        for row in cursor.fetchall():
            msg_id = row['message_id']
            emoji = row['emoji']
            username = row['username']

            if msg_id not in by_message:
                by_message[msg_id] = {}

            if emoji not in by_message[msg_id]:
                by_message[msg_id][emoji] = {"emoji": emoji, "usernames": [], "count": 0}

            by_message[msg_id][emoji]["usernames"].append(username)
            by_message[msg_id][emoji]["count"] += 1

        # Convert to list format
        return {
            msg_id: list(reactions.values())
            for msg_id, reactions in by_message.items()
        }
