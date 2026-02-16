"""Shared dependencies for FastAPI endpoints."""
import base64
from typing import Optional
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from .database import get_db

# Define the security scheme - this will show up in the docs
security = HTTPBearer(auto_error=False)


def get_username_from_credentials(credentials: Optional[HTTPAuthorizationCredentials]) -> Optional[str]:
    """Extract username from Bearer token credentials."""
    if not credentials:
        return None

    token = credentials.credentials
    try:
        decoded = base64.urlsafe_b64decode(token).decode('utf-8')
        username = decoded.split(':')[0]

        with get_db() as conn:
            cursor = conn.execute("SELECT username FROM users WHERE username = ? AND status = 'active'", (username,))
            if cursor.fetchone():
                return username
    except:
        pass

    return None


def get_username_from_token(credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> Optional[str]:
    """Optional authentication - returns username if valid token provided, None otherwise."""
    return get_username_from_credentials(credentials)


def require_auth(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Require authentication."""
    username = get_username_from_credentials(credentials)
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return username


def require_admin(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Require admin authentication."""
    username = get_username_from_credentials(credentials)
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")

    with get_db() as conn:
        cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
        row = cursor.fetchone()
        if not row or row['role'] != 'admin':
            raise HTTPException(status_code=403, detail="Admin access required")

    return username


def require_moderator(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Require moderator or admin authentication."""
    username = get_username_from_credentials(credentials)
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")

    with get_db() as conn:
        cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
        row = cursor.fetchone()
        if not row or row['role'] not in ('admin', 'moderator'):
            raise HTTPException(status_code=403, detail="Moderator access required")

    return username


def verify_token(token: str) -> Optional[str]:
    """Verify a token and return the username (for WebSocket auth)."""
    try:
        decoded = base64.urlsafe_b64decode(token).decode('utf-8')
        username = decoded.split(':')[0]

        with get_db() as conn:
            cursor = conn.execute("SELECT username FROM users WHERE username = ? AND status = 'active'", (username,))
            if cursor.fetchone():
                return username
    except:
        pass

    return None
