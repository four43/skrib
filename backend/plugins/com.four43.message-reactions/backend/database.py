"""Reactions plugin database operations."""
import sys
from pathlib import Path
from datetime import datetime, timezone

# Add parent directory to path to import mini_chat
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from mini_chat.database import get_db


def add_reaction(message_id: int, username: str, emoji: str) -> bool:
    """Add a reaction to a message.

    Args:
        message_id: ID of the message to react to
        username: User adding the reaction
        emoji: Emoji character

    Returns:
        True if added, False if duplicate
    """
    with get_db() as conn:
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
    """Remove a reaction from a message.

    Args:
        message_id: ID of the message
        username: User removing the reaction
        emoji: Emoji character
    """
    with get_db() as conn:
        conn.execute('''
            DELETE FROM message_reactions
            WHERE message_id = ? AND username = ? AND emoji = ?
        ''', (message_id, username, emoji))
        conn.commit()


def get_reactions(message_id: int) -> list:
    """Get all reactions for a message grouped by emoji.

    Args:
        message_id: ID of the message

    Returns:
        List of reaction objects:
        [{"emoji": "👍", "usernames": ["alice", "bob"], "count": 2}, ...]
    """
    with get_db() as conn:
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

    Args:
        message_ids: List of message IDs

    Returns:
        Dictionary mapping message ID to reactions:
        {
            123: [{"emoji": "👍", "usernames": ["alice"], "count": 1}],
            124: [{"emoji": "❤️", "usernames": ["bob", "charlie"], "count": 2}]
        }
    """
    if not message_ids:
        return {}

    with get_db() as conn:
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
