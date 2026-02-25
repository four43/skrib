"""Business logic for server operations."""
import secrets
from datetime import datetime
from pathlib import Path
from typing import Dict, List

from ..config import DB_DIR
from ..database import get_db, get_setting, set_setting
from ..users.avatar import generate_identicon


VALID_REGISTRATION_MODES = ('closed', 'invite_only', 'approval_required', 'open')

# Server icon file path in the data directory
SERVER_ICON_PATH = DB_DIR / "server_icon.png"

# Default color for auto-generated server icon
SERVER_ICON_COLOR = '#6366f1'


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
    return {
        'registration_mode': get_registration_mode(),
        'default_theme': get_setting('default_theme', 'four43.theme-default'),
        'name': get_setting('server_name', 'My Server'),
        'icon_custom': is_server_icon_custom(),
        'dm_room_type': get_setting('dm_room_type', 'four43.room-type-chat'),
    }


def get_server_icon() -> bytes:
    """Get the server icon PNG bytes.

    Returns the custom icon if one has been uploaded, otherwise
    auto-generates a deterministic identicon from the server name.
    """
    if is_server_icon_custom() and SERVER_ICON_PATH.exists():
        return SERVER_ICON_PATH.read_bytes()

    # Auto-generate from server name
    server_name = get_setting('server_name', 'My Server')
    return generate_identicon(server_name, SERVER_ICON_COLOR)


def set_server_icon(data: bytes) -> None:
    """Save a custom server icon (PNG bytes)."""
    SERVER_ICON_PATH.write_bytes(data)
    set_setting('server_icon_custom', 'true')


def reset_server_icon() -> None:
    """Remove custom icon and revert to auto-generated."""
    if SERVER_ICON_PATH.exists():
        SERVER_ICON_PATH.unlink()
    set_setting('server_icon_custom', 'false')


def is_server_icon_custom() -> bool:
    """Check whether the server icon is a custom upload."""
    return get_setting('server_icon_custom', 'false') == 'true'
