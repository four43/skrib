"""Business logic for authentication."""
import re
import secrets
import base64
from datetime import datetime, timedelta
from typing import Optional, Tuple

from ..database import get_db, get_setting
from ..users.avatar import generate_identicon

# Matplotlib "tab10" color cycle — 10 perceptually distinct, medium-bright colors
# designed for good mutual contrast.  We assign them round-robin by total user count.
USER_COLOR_PALETTE = [
    '#1f77b4',  # blue
    '#ff7f0e',  # orange
    '#2ca02c',  # green
    '#d62728',  # red
    '#9467bd',  # purple
    '#17becf',  # cyan
    '#e377c2',  # pink
    '#bcbd22',  # yellow-green
    '#8c564b',  # brown
    '#f7b6d2',  # light pink
]

# TTL for challenges and registration tokens
REGISTRATION_TOKEN_TTL = timedelta(minutes=5)
CHALLENGE_TTL = timedelta(minutes=5)

# Username rules (Twitter/X-style)
USERNAME_RE = re.compile(r'^[a-zA-Z0-9_]{4,15}$')
RESERVED_WORDS = ['admin', 'skrib', 'system']


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


def is_username_taken(username: str) -> bool:
    """Check if a username is already registered."""
    with get_db() as conn:
        cursor = conn.execute('SELECT 1 FROM users WHERE username = ?', (username,))
        return cursor.fetchone() is not None


def create_registration_token(username: str) -> str:
    """Create a short-lived token that ties a validated username to step 2."""
    token = secrets.token_urlsafe(32)
    with get_db() as conn:
        conn.execute('''
            INSERT INTO challenges (challenge, type, username, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (token, 'registration_step1', username, datetime.now().isoformat()))
        conn.commit()
    return token


def get_registration_token_info(token: str) -> Optional[dict]:
    """Look up a step-1 registration token. Returns {'username': ...} or None.

    Enforces a TTL — tokens older than REGISTRATION_TOKEN_TTL are rejected.
    """
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT username, timestamp FROM challenges
            WHERE challenge = ? AND type = 'registration_step1'
        ''', (token,))
        row = cursor.fetchone()
        if row:
            created = datetime.fromisoformat(row['timestamp'])
            if datetime.now() - created > REGISTRATION_TOKEN_TTL:
                # Expired — clean it up
                conn.execute('DELETE FROM challenges WHERE challenge = ?', (token,))
                conn.commit()
                return None
            return {'username': row['username']}
    return None


def consume_registration_token(token: str) -> Optional[dict]:
    """Look up and delete a registration token. Returns {'username': ...} or None."""
    info = get_registration_token_info(token)
    if info:
        with get_db() as conn:
            conn.execute(
                "DELETE FROM challenges WHERE challenge = ? AND type = 'registration_step1'",
                (token,),
            )
            conn.commit()
    return info


def generate_challenge() -> str:
    """Generate a WebAuthn challenge."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8').rstrip('=')


def store_challenge(challenge: str, challenge_type: str,
                    username: Optional[str] = None,
                    registration_token: Optional[str] = None):
    """Store a challenge in the database.

    If registration_token is provided, the challenge is bound to that token
    and can only be verified with the same token.
    """
    # Store the registration_token in the username field for binding
    # (registration challenges use this to bind challenge → token)
    bound_value = registration_token if registration_token else username
    with get_db() as conn:
        conn.execute('''
            INSERT INTO challenges (challenge, type, username, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (challenge, challenge_type, bound_value, datetime.now().isoformat()))
        conn.commit()


def verify_challenge(challenge: str, challenge_type: str,
                     username: Optional[str] = None,
                     registration_token: Optional[str] = None) -> bool:
    """Verify and consume a challenge.

    Enforces TTL — challenges older than CHALLENGE_TTL are rejected.
    If registration_token is provided, the challenge must be bound to that token.
    """
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT * FROM challenges
            WHERE challenge = ? AND type = ?
        ''', (challenge, challenge_type))
        row = cursor.fetchone()

        if not row:
            return False

        # TTL check
        created = datetime.fromisoformat(row['timestamp'])
        if datetime.now() - created > CHALLENGE_TTL:
            conn.execute('DELETE FROM challenges WHERE challenge = ?', (challenge,))
            conn.commit()
            return False

        # Binding check: if a registration_token was provided, the stored
        # value (in the username column) must match it.
        if registration_token:
            if row['username'] != registration_token:
                return False
        elif username and row['username'] and row['username'] != username:
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
                        invite_token: Optional[str] = None,
                        encryption_public_key: Optional[str] = None,
                        passphrase_encrypted_private_key: Optional[str] = None,
                        encrypted_private_key: Optional[str] = None) -> tuple[str, bool]:
    """Create a user and return (approval_code, is_auto_approved).

    Determines role/status/approved_by from the registration mode and user count.
    """
    approval_code = generate_approval_code()
    mode = get_registration_mode()
    now = datetime.now().isoformat()

    # Read user counts to pick a color (read-only, no write lock)
    with get_db() as conn:
        active_count = conn.execute(
            "SELECT COUNT(*) as c FROM users WHERE status = 'active'"
        ).fetchone()['c']
        total_count = conn.execute(
            "SELECT COUNT(*) as c FROM users"
        ).fetchone()['c']

    # Generate identicon outside DB connection to avoid holding a write lock
    color = USER_COLOR_PALETTE[total_count % len(USER_COLOR_PALETTE)]
    avatar_data = generate_identicon(username, color)

    # Determine role, status, and approval source
    if active_count == 0:
        role, status, approved_by = 'admin', 'active', 'system'
    elif mode == 'open':
        role, status, approved_by = 'user', 'active', 'open'
    elif mode == 'invite_only' and invite_token:
        consume_invite_token(invite_token, username)
        role, status, approved_by = 'user', 'active', 'invite'
    else:
        # approval_required (or any other mode)
        role, status, approved_by = 'user', 'pending', None

    is_auto_approved = status == 'active'

    with get_db() as conn:
        conn.execute('''
            INSERT INTO users (
                username, credential_id, public_key, role, status, color,
                avatar_data, approval_code, created_at, approved_at, approved_by,
                encryption_public_key, passphrase_encrypted_private_key, encrypted_private_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            username, credential_id, public_key, role, status, color,
            avatar_data, approval_code if not is_auto_approved else None,
            now, now if is_auto_approved else None, approved_by,
            encryption_public_key, passphrase_encrypted_private_key, encrypted_private_key,
        ))
        conn.commit()

    return (approval_code, is_auto_approved)


def get_user_credentials(username: str) -> Optional[dict]:
    """Get user credentials for login."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT credential_id, public_key, role
            FROM users
            WHERE username = ? AND status = 'active'
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
            WHERE credential_id = ? AND status = 'active'
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
                WHERE username = ? AND status = 'active'
            ''', (username,))
            row = cursor.fetchone()

            if row:
                return (row['username'], row['role'])
    except:
        pass

    return None
