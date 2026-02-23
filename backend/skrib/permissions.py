"""Shared permission checking utilities.

Centralizes room access and edit permission logic so plugins
don't reimplement these checks.
"""
from fastapi import HTTPException

from .database import get_db
from .rooms.services import (
    room_exists,
    is_dm,
    get_room_members,
    get_room_role,
    ensure_room_exists,
)


def check_room_access(room_id: str, username: str):
    """Verify room exists and user has access. For DMs, checks membership."""
    if not room_exists(room_id):
        ensure_room_exists(room_id)

    if is_dm(room_id):
        members = get_room_members(room_id)
        if username not in members:
            raise HTTPException(status_code=403, detail="Not a member of this DM")


def check_room_membership(room_id: str, username: str):
    """Raise 403 if user is not a room member."""
    if not room_exists(room_id):
        raise HTTPException(status_code=404, detail="Room not found")
    members = get_room_members(room_id)
    if username not in members:
        raise HTTPException(status_code=403, detail="Not a member of this room")


def get_global_role(username: str) -> str:
    """Get user's global role (admin/moderator/user)."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT role FROM users WHERE username = ?', (username,)
        )
        row = cursor.fetchone()
        return row['role'] if row else 'user'


def require_room_op_or_global_mod(room_id: str, username: str):
    """Raise 403 unless user is room owner/op or global admin/moderator."""
    room_role = get_room_role(room_id, username)
    if room_role in ('owner', 'op'):
        return
    global_role_ = get_global_role(username)
    if global_role_ in ('admin', 'moderator'):
        return
    raise HTTPException(status_code=403, detail="Room op or moderator required")


def can_edit_resource(room_id: str, username: str, creator_username: str) -> bool:
    """Check if user can edit a resource (creator, room op, or global admin/mod)."""
    if username == creator_username:
        return True

    role = get_room_role(room_id, username)
    if role in ('owner', 'op'):
        return True

    global_role_ = get_global_role(username)
    if global_role_ in ('admin', 'moderator'):
        return True

    return False


def require_edit_permission(room_id: str, username: str, creator_username: str):
    """Raise 403 unless user can edit. Calls can_edit_resource()."""
    if not can_edit_resource(room_id, username, creator_username):
        raise HTTPException(
            status_code=403,
            detail="Only the creator, room ops, or admins can edit this item",
        )
