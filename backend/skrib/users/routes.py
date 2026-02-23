"""Users API routes — preferences and user management."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..dependencies import require_auth, require_admin, require_moderator, get_username_from_token
from pydantic import BaseModel
from .avatar import get_or_generate_avatar
from .schemas import (
    UpdatePendingUserRequest,
    UserInfo,
    UserProfile,
    UserUpdateRequest,
)
from .services import (
    get_user_preferences,
    update_user_preferences,
    get_all_user_preferences,
    approve_user,
    reject_user,
    get_all_users,
    set_user_role,
    revoke_user_access,
)

router = APIRouter(prefix="/users", tags=["users"])


# --- User management (admin/moderator) ---

@router.get("", response_model=list[UserInfo])
async def list_all_users(
    status: Optional[str] = None,
    _: str = Depends(require_auth)
):
    """Get list of all users, optionally filtered by status (e.g., ?status=pending)."""
    return get_all_users(status=status)


@router.patch("/pending/{approval_code}")
async def update_pending_user(
    approval_code: str,
    request: UpdatePendingUserRequest,
    admin: str = Depends(require_moderator),
):
    """Approve or reject a pending user."""
    if request.status == 'approved':
        if not approve_user(approval_code, admin):
            raise HTTPException(status_code=404, detail="Pending user not found")
    elif request.status == 'rejected':
        if not reject_user(approval_code):
            raise HTTPException(status_code=404, detail="Pending user not found")

    return {"approval_code": approval_code, "action": request.status}


@router.delete("/{username}")
async def delete_user(username: str, _: str = Depends(require_admin)):
    """Delete a user."""
    if not revoke_user_access(username):
        raise HTTPException(
            status_code=400,
            detail="Cannot delete user (not found or last admin)",
        )
    return {}


# --- Avatar ---

@router.get("/{username}/avatar")
async def get_avatar(username: str):
    """Get user avatar image. Public endpoint (no auth required)."""
    avatar_data = get_or_generate_avatar(username)
    if not avatar_data:
        raise HTTPException(status_code=404, detail="User not found")
    return Response(
        content=avatar_data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# --- User profile and properties ---

@router.get("/{target_username}", response_model=UserProfile)
async def get_user_profile(
    target_username: str,
    username: str = Depends(get_username_from_token),
):
    """Get user profile. Users can access their own, admins can access any."""
    from ..database import get_db

    # Check permissions
    if target_username != username:
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            if not row or row['role'] != 'admin':
                raise HTTPException(status_code=403, detail="Not authorized")

    # Get user profile
    prefs = get_user_preferences(target_username)
    if not prefs:
        raise HTTPException(status_code=404, detail="User not found")

    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username, role, status FROM users WHERE username = ?',
            (target_username,)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")

        return UserProfile(
            username=row['username'],
            role=row['role'],
            status=row['status'],
            color=prefs['color'],
            theme_name=prefs.get('theme_name'),
            color_scheme=prefs.get('color_scheme'),
            nickname=prefs.get('nickname'),
        )


@router.patch("/{target_username}")
async def update_user(
    target_username: str,
    updates: UserUpdateRequest,
    username: str = Depends(get_username_from_token),
):
    """Update user properties. Users can update their own preferences, admins can update roles."""
    from ..database import get_db

    # Check if target user exists
    with get_db() as conn:
        cursor = conn.execute('SELECT username FROM users WHERE username = ?', (target_username,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="User not found")

    # Check permissions
    is_self = target_username == username
    is_admin = False
    if not is_self:
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            is_admin = row and row['role'] == 'admin'
            if not is_admin:
                raise HTTPException(status_code=403, detail="Not authorized")

    # Update preferences (color, theme_name, color_scheme, nickname) - users can update their own
    pref_fields = [updates.color, updates.theme_name, updates.color_scheme, updates.nickname]
    if any(f is not None for f in pref_fields):
        if not is_self and not is_admin:
            raise HTTPException(status_code=403, detail="You can only change your own preferences")
        update_user_preferences(
            target_username,
            color=updates.color,
            theme_name=updates.theme_name,
            color_scheme=updates.color_scheme,
            nickname=updates.nickname
        )

    # Update role - admin only
    if updates.role is not None:
        if not is_admin:
            raise HTTPException(status_code=403, detail="Admin required to change roles")
        if updates.role not in ['admin', 'moderator', 'user']:
            raise HTTPException(status_code=400, detail="Invalid role")
        if not set_user_role(target_username, updates.role):
            raise HTTPException(status_code=404, detail="User not found")

    return {}


# --- Preferences ---

@router.get("/preferences/colors")
async def get_all_user_colors(username: str = Depends(require_auth)):
    """Get all users' color preferences (for efficient message rendering)."""
    return get_all_user_preferences()
