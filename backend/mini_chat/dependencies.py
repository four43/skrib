"""Shared dependencies for FastAPI endpoints."""
import base64
from typing import Optional
from fastapi import Header, HTTPException

from .database import get_db


def get_username_from_token(authorization: Optional[str] = Header(None)) -> Optional[str]:
    """Extract username from Bearer token."""
    if not authorization or not authorization.startswith('Bearer '):
        return None

    token = authorization[7:]
    try:
        decoded = base64.urlsafe_b64decode(token).decode('utf-8')
        username = decoded.split(':')[0]

        with get_db() as conn:
            cursor = conn.execute('SELECT username FROM users WHERE username = ?', (username,))
            if cursor.fetchone():
                return username
    except:
        pass

    return None


def require_auth(authorization: Optional[str] = Header(None)) -> str:
    """Require authentication."""
    username = get_username_from_token(authorization)
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return username


def require_admin(authorization: Optional[str] = Header(None)) -> str:
    """Require admin authentication."""
    username = require_auth(authorization)

    with get_db() as conn:
        cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
        row = cursor.fetchone()
        if not row or row['role'] != 'admin':
            raise HTTPException(status_code=403, detail="Admin access required")

    return username


def require_moderator(authorization: Optional[str] = Header(None)) -> str:
    """Require moderator or admin authentication."""
    username = require_auth(authorization)

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
            cursor = conn.execute('SELECT username FROM users WHERE username = ?', (username,))
            if cursor.fetchone():
                return username
    except:
        pass

    return None
