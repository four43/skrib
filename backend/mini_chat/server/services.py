"""Business logic for server operations."""
import secrets
from datetime import datetime
from typing import Dict, List

from ..database import get_db, get_setting, set_setting


VALID_REGISTRATION_MODES = ('closed', 'invite_only', 'approval_required', 'open')


def set_registration_mode(mode: str) -> str:
    """Set the registration mode."""
    if mode not in VALID_REGISTRATION_MODES:
        raise ValueError(f"Invalid registration mode: {mode}")
    set_setting('registration_mode', mode)
    return mode


def get_registration_mode() -> str:
    """Get the current registration mode."""
    return get_setting('registration_mode', 'closed')


def create_invite_token(admin_username: str) -> str:
    """Create a new invite token. Returns the token string."""
    token = secrets.token_urlsafe(32)
    with get_db() as conn:
        conn.execute('''
            INSERT INTO invite_tokens (token, created_by, created_at)
            VALUES (?, ?, ?)
        ''', (token, admin_username, datetime.now().isoformat()))
        conn.commit()
    return token


def get_invite_tokens() -> List[Dict]:
    """Get all invite tokens."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT token, created_by, created_at, used_by, used_at
            FROM invite_tokens
            ORDER BY created_at DESC
        ''')
        return [dict(row) for row in cursor]


def delete_invite_token(token: str) -> bool:
    """Delete an invite token."""
    with get_db() as conn:
        cursor = conn.execute(
            'DELETE FROM invite_tokens WHERE token = ?', (token,)
        )
        conn.commit()
        return cursor.rowcount > 0


def get_system_status() -> Dict:
    """Get system status."""
    with get_db() as conn:
        users_count = conn.execute("SELECT COUNT(*) as count FROM users WHERE status = 'active'").fetchone()['count']
        pending_count = conn.execute("SELECT COUNT(*) as count FROM users WHERE status = 'pending'").fetchone()['count']
        rooms_count = conn.execute('SELECT COUNT(DISTINCT room_id) as count FROM messages').fetchone()['count']
        messages_count = conn.execute('SELECT COUNT(*) as count FROM messages').fetchone()['count']

    return {
        'users_count': users_count,
        'pending_count': pending_count,
        'rooms_count': rooms_count,
        'messages_count': messages_count,
        'registration_mode': get_registration_mode(),
        'server_color': get_setting('server_color', '#6366f1'),
        'default_theme': get_setting('default_theme', 'com.four43.theme-default'),
    }
