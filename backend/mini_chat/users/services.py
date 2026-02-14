"""Business logic for user operations."""
from datetime import datetime
from typing import Dict, List, Optional

from ..database import get_db


def get_user_preferences(username: str) -> Optional[Dict]:
    """Get preferences for a user. Returns None if not found."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username, color, theme_color, nickname FROM user_preferences WHERE username = ?',
            (username,)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def create_default_preferences(username: str) -> Dict:
    """Create default preferences for a user."""
    with get_db() as conn:
        conn.execute(
            'INSERT INTO user_preferences (username, color) VALUES (?, ?)',
            (username, '#1976d2')
        )
        conn.commit()
        return {'username': username, 'color': '#1976d2', 'theme_color': None, 'nickname': None}


def update_user_preferences(username: str, color: Optional[str] = None, theme_color: Optional[str] = None, nickname: Optional[str] = None) -> bool:
    """Update user preferences. Creates default if doesn't exist."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username FROM user_preferences WHERE username = ?',
            (username,)
        )
        if cursor.fetchone():
            # Build SET clause dynamically for provided fields
            updates = []
            params = []
            if color is not None:
                updates.append('color = ?')
                params.append(color)
            if theme_color is not None:
                # Empty string means "use server default"
                updates.append('theme_color = ?')
                params.append(theme_color if theme_color != '' else None)
            if nickname is not None:
                # Empty string means "clear nickname, use username"
                trimmed = nickname.strip()
                updates.append('nickname = ?')
                params.append(trimmed if trimmed and len(trimmed) <= 32 else None)

            if updates:
                params.append(username)
                conn.execute(
                    f'UPDATE user_preferences SET {", ".join(updates)} WHERE username = ?',
                    params
                )
        else:
            nick_val = nickname.strip() if nickname else None
            if nick_val and len(nick_val) > 32:
                nick_val = None
            conn.execute(
                'INSERT INTO user_preferences (username, color, theme_color, nickname) VALUES (?, ?, ?, ?)',
                (username, color or '#1976d2', theme_color if theme_color else None, nick_val)
            )
        conn.commit()
        return True


def get_all_user_preferences() -> Dict[str, Dict]:
    """Get all user preferences as a dict mapping username -> {color, nickname}."""
    with get_db() as conn:
        cursor = conn.execute('SELECT username, color, nickname FROM user_preferences')
        return {row['username']: {'color': row['color'], 'nickname': row['nickname']} for row in cursor}


def get_pending_users() -> List[Dict]:
    """Get all pending users."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT username, approval_code, registered_at
            FROM pending_users
            WHERE approved = 0
            ORDER BY registered_at DESC
        ''')
        return [dict(row) for row in cursor]


def approve_user(approval_code: str, admin_username: str) -> bool:
    """Approve a pending user."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT username, credential_id, public_key
            FROM pending_users
            WHERE approval_code = ? AND approved = 0
        ''', (approval_code,))
        pending = cursor.fetchone()

        if not pending:
            return False

        cursor = conn.execute('SELECT COUNT(*) as count FROM users')
        user_count = cursor.fetchone()['count']
        role = 'admin' if user_count == 0 else 'user'

        conn.execute('''
            INSERT INTO users (username, credential_id, public_key, role, approved, approved_at, approved_by)
            VALUES (?, ?, ?, ?, 1, ?, ?)
        ''', (pending['username'], pending['credential_id'], pending['public_key'], role,
              datetime.now().isoformat(), admin_username))

        conn.execute('''
            UPDATE pending_users SET approved = 1 WHERE approval_code = ?
        ''', (approval_code,))

        conn.commit()
        return True


def reject_user(approval_code: str) -> bool:
    """Reject a pending user."""
    with get_db() as conn:
        cursor = conn.execute('''
            DELETE FROM pending_users
            WHERE approval_code = ? AND approved = 0
        ''', (approval_code,))
        conn.commit()
        return cursor.rowcount > 0


def get_all_users() -> List[Dict]:
    """Get all approved users."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT username, role, approved, approved_at, approved_by
            FROM users
            ORDER BY username
        ''')
        return [dict(row) for row in cursor]


def set_user_role(username: str, role: str) -> bool:
    """Set user role."""
    with get_db() as conn:
        cursor = conn.execute('''
            UPDATE users SET role = ? WHERE username = ?
        ''', (role, username))
        conn.commit()
        return cursor.rowcount > 0


def revoke_user_access(username: str) -> bool:
    """Revoke user access."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT COUNT(*) as count FROM users WHERE role = 'admin'
        ''')
        admin_count = cursor.fetchone()['count']

        if admin_count <= 1:
            row = conn.execute(
                'SELECT role FROM users WHERE username = ?', (username,)
            ).fetchone()
            if row and row['role'] == 'admin':
                return False

        cursor = conn.execute('DELETE FROM users WHERE username = ?', (username,))
        conn.commit()
        return cursor.rowcount > 0
