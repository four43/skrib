"""Business logic for user operations."""
from datetime import datetime
from typing import Dict, List, Optional

from ..database import get_db
from .avatar import generate_identicon


def get_user_preferences(username: str) -> Optional[Dict]:
    """Get preferences for a user. Returns None if not found."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username, color, theme_name, color_scheme, nickname FROM users WHERE username = ? AND status = ?',
            (username, 'active')
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def update_user_preferences(username: str, color: Optional[str] = None, theme_name: Optional[str] = None, color_scheme: Optional[str] = None, nickname: Optional[str] = None) -> bool:
    """Update user preferences on the users table."""
    updates = []
    params = []
    if color is not None:
        updates.append('color = ?')
        params.append(color)
    if theme_name is not None:
        # Empty string means "use server default"
        updates.append('theme_name = ?')
        params.append(theme_name if theme_name != '' else None)
    if color_scheme is not None:
        # Validate value
        updates.append('color_scheme = ?')
        params.append(color_scheme if color_scheme in ('auto', 'light', 'dark') else None)
    if nickname is not None:
        # Empty string means "clear nickname, use username"
        trimmed = nickname.strip()
        updates.append('nickname = ?')
        params.append(trimmed if trimmed and len(trimmed) <= 32 else None)

    if color is not None:
        # Regenerate identicon outside DB connection to avoid holding a write lock
        avatar_data = generate_identicon(username, color)
        updates.append('avatar_data = ?')
        params.append(avatar_data)

    if updates:
        params.append(username)
        with get_db() as conn:
            conn.execute(
                f'UPDATE users SET {", ".join(updates)} WHERE username = ?',
                params
            )
            conn.commit()
    return True


def get_all_user_preferences() -> Dict[str, Dict]:
    """Get all user preferences as a dict mapping username -> {color, nickname}."""
    with get_db() as conn:
        cursor = conn.execute("SELECT username, color, nickname FROM users WHERE status = 'active'")
        return {row['username']: {'color': row['color'], 'nickname': row['nickname']} for row in cursor}


def approve_user(approval_code: str, admin_username: str) -> bool:
    """Approve a pending user."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT username FROM users
            WHERE approval_code = ? AND status = 'pending'
        ''', (approval_code,))
        pending = cursor.fetchone()

        if not pending:
            return False

        # Check if this would be the first active user (make them admin)
        cursor = conn.execute("SELECT COUNT(*) as count FROM users WHERE status = 'active'")
        user_count = cursor.fetchone()['count']
        role = 'admin' if user_count == 0 else 'user'

        conn.execute('''
            UPDATE users SET status = 'active', role = ?, approved_at = ?, approved_by = ?
            WHERE approval_code = ? AND status = 'pending'
        ''', (role, datetime.now().isoformat(), admin_username, approval_code))

        conn.commit()
        return True


def reject_user(approval_code: str) -> bool:
    """Reject a pending user."""
    with get_db() as conn:
        cursor = conn.execute('''
            DELETE FROM users
            WHERE approval_code = ? AND status = 'pending'
        ''', (approval_code,))
        conn.commit()
        return cursor.rowcount > 0


def get_all_users(status: Optional[str] = None) -> List[Dict]:
    """Get all users, optionally filtered by status."""
    with get_db() as conn:
        query = '''
            SELECT username, role, status, approved_at, approved_by, approval_code, created_at
            FROM users
        '''
        params = []

        if status:
            query += ' WHERE status = ?'
            params.append(status)
        else:
            # Default to active users only if no status filter
            query += ' WHERE status = ?'
            params.append('active')

        query += ' ORDER BY created_at DESC, username'

        cursor = conn.execute(query, params)
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
            SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'
        ''')
        admin_count = cursor.fetchone()['count']

        if admin_count <= 1:
            row = conn.execute(
                "SELECT role FROM users WHERE username = ? AND status = 'active'", (username,)
            ).fetchone()
            if row and row['role'] == 'admin':
                return False

        cursor = conn.execute('DELETE FROM users WHERE username = ?', (username,))
        conn.commit()
        return cursor.rowcount > 0
