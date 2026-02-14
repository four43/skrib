"""Business logic for authentication."""
import re
import secrets
import base64
from datetime import datetime
from typing import Optional, Tuple

from ..database import get_db, get_setting

# Username rules (Twitter/X-style)
USERNAME_RE = re.compile(r'^[a-zA-Z0-9_]{4,15}$')
RESERVED_WORDS = ['admin', 'minichat', 'system']


def validate_username(username: str) -> Optional[str]:
    """Validate a username. Returns an error message, or None if valid."""
    if not username:
        return "Username is required"
    if len(username) < 4:
        return "Username must be at least 4 characters"
    if len(username) > 15:
        return "Username must be 15 characters or fewer"
    if not USERNAME_RE.match(username):
        return "Username can only contain letters, numbers, and underscores"
    lower = username.lower()
    for word in RESERVED_WORDS:
        if word in lower:
            return f"Username cannot contain '{word}'"
    return None


def generate_challenge() -> str:
    """Generate a WebAuthn challenge."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8').rstrip('=')


def store_challenge(challenge: str, challenge_type: str, username: Optional[str] = None):
    """Store a challenge in the database."""
    with get_db() as conn:
        conn.execute('''
            INSERT INTO challenges (challenge, type, username, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (challenge, challenge_type, username, datetime.now().isoformat()))
        conn.commit()


def verify_challenge(challenge: str, challenge_type: str, username: Optional[str] = None) -> bool:
    """Verify and consume a challenge."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT * FROM challenges
            WHERE challenge = ? AND type = ?
        ''', (challenge, challenge_type))
        row = cursor.fetchone()

        if not row:
            return False

        if username and row['username'] and row['username'] != username:
            return False

        # Delete used challenge
        conn.execute('DELETE FROM challenges WHERE challenge = ?', (challenge,))
        conn.commit()

        return True


def get_registration_mode() -> str:
    """Get the current registration mode."""
    return get_setting('registration_mode', 'closed')


def is_registration_allowed(invite_token: Optional[str] = None) -> bool:
    """Check if registration is allowed given the current mode and optional invite token."""
    mode = get_registration_mode()
    if mode == 'closed':
        return False
    if mode == 'invite_only':
        if not invite_token:
            return False
        return validate_invite_token(invite_token)
    # approval_required and open both allow registration
    return True


def validate_invite_token(token: str) -> bool:
    """Check if an invite token is valid (exists and unused)."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT token FROM invite_tokens
            WHERE token = ? AND used_by IS NULL
        ''', (token,))
        return cursor.fetchone() is not None


def consume_invite_token(token: str, username: str):
    """Mark an invite token as used."""
    with get_db() as conn:
        conn.execute('''
            UPDATE invite_tokens
            SET used_by = ?, used_at = ?
            WHERE token = ? AND used_by IS NULL
        ''', (username, datetime.now().isoformat(), token))
        conn.commit()


def generate_approval_code() -> str:
    """Generate a unique approval code."""
    return secrets.token_hex(6).upper()


def create_pending_user(username: str, credential_id: str, public_key: str,
                        invite_token: Optional[str] = None) -> tuple[str, bool]:
    """Create a pending user and return approval code and whether auto-approved.

    Returns:
        tuple: (approval_code, is_auto_approved)
    """
    approval_code = generate_approval_code()
    mode = get_registration_mode()

    with get_db() as conn:
        # Check if this is the first user
        cursor = conn.execute('SELECT COUNT(*) as count FROM users')
        user_count = cursor.fetchone()['count']

        if user_count == 0:
            # First user - auto-approve as admin
            conn.execute('''
                INSERT INTO users (username, credential_id, public_key, role, approved, approved_at, approved_by)
                VALUES (?, ?, ?, 'admin', 1, ?, 'system')
            ''', (username, credential_id, public_key, datetime.now().isoformat()))
            conn.commit()
            return (approval_code, True)

        if mode == 'open':
            # Open mode - auto-approve immediately
            conn.execute('''
                INSERT INTO users (username, credential_id, public_key, role, approved, approved_at, approved_by)
                VALUES (?, ?, ?, 'user', 1, ?, 'OPEN_STATE')
            ''', (username, credential_id, public_key, datetime.now().isoformat()))
            conn.commit()
            return (approval_code, True)

        if mode == 'invite_only' and invite_token:
            # Invite-only mode with valid token - auto-approve
            consume_invite_token(invite_token, username)
            conn.execute('''
                INSERT INTO users (username, credential_id, public_key, role, approved, approved_at, approved_by)
                VALUES (?, ?, ?, 'user', 1, ?, 'INVITE')
            ''', (username, credential_id, public_key, datetime.now().isoformat()))
            conn.commit()
            return (approval_code, True)

        # approval_required mode - require approval
        conn.execute('''
            INSERT INTO pending_users (username, credential_id, public_key, approval_code, registered_at)
            VALUES (?, ?, ?, ?, ?)
        ''', (username, credential_id, public_key, approval_code, datetime.now().isoformat()))
        conn.commit()
        return (approval_code, False)


def get_user_credentials(username: str) -> Optional[dict]:
    """Get user credentials for login."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT credential_id, public_key, role
            FROM users
            WHERE username = ? AND approved = 1
        ''', (username,))
        row = cursor.fetchone()

        if row:
            return {
                'credential_id': row['credential_id'],
                'public_key': row['public_key'],
                'role': row['role']
            }
        return None


def get_user_by_credential(credential_id: str) -> Optional[dict]:
    """Get user by credential ID."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT username, role
            FROM users
            WHERE credential_id = ? AND approved = 1
        ''', (credential_id,))
        row = cursor.fetchone()

        if row:
            return {
                'username': row['username'],
                'role': row['role']
            }
        return None


def create_session_token(username: str) -> str:
    """Create a session token for a user."""
    token_data = f"{username}:{secrets.token_hex(32)}"
    return base64.urlsafe_b64encode(token_data.encode()).decode()


def get_user_from_session(token: str) -> Optional[Tuple[str, str]]:
    """Get username and role from session token."""
    try:
        decoded = base64.urlsafe_b64decode(token).decode('utf-8')
        username = decoded.split(':')[0]

        with get_db() as conn:
            cursor = conn.execute('''
                SELECT username, role
                FROM users
                WHERE username = ? AND approved = 1
            ''', (username,))
            row = cursor.fetchone()

            if row:
                return (row['username'], row['role'])
    except:
        pass

    return None
