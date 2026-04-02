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


# --- Bulk endpoints (must be before /{target_username} to avoid path collision) ---

@router.get("/presence")
async def get_all_presence(username: str = Depends(require_auth)):
    """Get online/offline status for all active users."""
    from ..ws import bus
    users = get_all_users(status='active')
    return {
        u['username']: (
            u['username'] in bus.user_connections
            and bool(bus.user_connections[u['username']])
        )
        for u in users
    }


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

@router.get("/{target_username}/presence")
async def get_user_presence(
    target_username: str,
    _: str = Depends(require_auth),
):
    """Check if a user has active WebSocket connections."""
    from ..ws import bus
    connected = (
        target_username in bus.user_connections
        and bool(bus.user_connections[target_username])
    )
    return {"username": target_username, "connected": connected}


@router.get("/{target_username}", response_model=UserProfile)
async def get_user_profile(
    target_username: str,
    username: str = Depends(require_auth),
):
    """Get user profile. Any authenticated user can view any profile."""
    from ..database import get_db

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
            status_emoji=prefs.get('status_emoji'),
            status_text=prefs.get('status_text'),
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

    # Update preferences (color, theme_name, color_scheme, nickname, status) - users can update their own
    pref_fields = [updates.color, updates.theme_name, updates.color_scheme, updates.nickname, updates.status_emoji, updates.status_text]
    if any(f is not None for f in pref_fields):
        if not is_self and not is_admin:
            raise HTTPException(status_code=403, detail="You can only change your own preferences")
        update_user_preferences(
            target_username,
            color=updates.color,
            theme_name=updates.theme_name,
            color_scheme=updates.color_scheme,
            nickname=updates.nickname,
            status_emoji=updates.status_emoji,
            status_text=updates.status_text,
        )
        # Broadcast user preference changes to all connected clients
        from ..ws import bus
        changed = {}
        if updates.color is not None:
            changed['color'] = updates.color
        if updates.nickname is not None:
            changed['nickname'] = updates.nickname if updates.nickname.strip() else None
        if updates.status_emoji is not None:
            changed['status_emoji'] = updates.status_emoji.strip()[:8] if updates.status_emoji.strip() else None
        if updates.status_text is not None:
            changed['status_text'] = updates.status_text.strip()[:128] if updates.status_text.strip() else None
        if changed:
            await bus.notify_all_users({
                "type": "system:user_updated",
                "username": target_username,
                **changed,
            })

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
