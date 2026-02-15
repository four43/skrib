"""Users API routes — preferences and user management."""
from fastapi import APIRouter, Depends, HTTPException

from ..dependencies import require_auth, require_admin, require_moderator, get_username_from_token
from pydantic import BaseModel
from .schemas import (
    GetPreferencesResponse,
    UpdatePreferencesRequest,
    UpdatePreferencesResponse,
    PendingUsersResponse,
    ApproveUserRequest,
    RejectUserRequest,
    UsersListResponse,
)
from .services import (
    get_user_preferences,
    update_user_preferences,
    get_all_user_preferences,
    get_pending_users,
    approve_user,
    reject_user,
    get_all_users,
    set_user_role,
    revoke_user_access,
)

router = APIRouter(prefix="/users", tags=["users"])


# --- User management (admin/moderator) ---

@router.get("", response_model=UsersListResponse)
async def list_all_users(_: str = Depends(require_moderator)):
    """Get list of all users."""
    users = get_all_users()
    return UsersListResponse(users=users)


@router.get("/pending", response_model=PendingUsersResponse)
async def list_pending_users(admin: str = Depends(require_moderator)):
    """Get list of pending user approvals."""
    pending = get_pending_users()
    return PendingUsersResponse(pending=pending)


@router.post("/pending/approve")
async def approve_pending_user(
    request: ApproveUserRequest,
    admin: str = Depends(require_moderator),
):
    """Approve a pending user."""
    if not approve_user(request.approval_code, admin):
        raise HTTPException(status_code=404, detail="Pending user not found")
    return {"status": "ok"}


@router.post("/pending/reject")
async def reject_pending_user(
    request: RejectUserRequest,
    _: str = Depends(require_moderator),
):
    """Reject a pending user."""
    if not reject_user(request.approval_code):
        raise HTTPException(status_code=404, detail="Pending user not found")
    return {"status": "ok"}


@router.delete("/{username}")
async def delete_user(username: str, _: str = Depends(require_admin)):
    """Delete a user."""
    if not revoke_user_access(username):
        raise HTTPException(
            status_code=400,
            detail="Cannot delete user (not found or last admin)",
        )
    return {"status": "ok"}


# --- User list (authenticated, non-admin) ---

@router.get("/list")
async def list_usernames(_: str = Depends(require_auth)):
    """Get list of all usernames (for DM picker)."""
    users = get_all_users()
    return {"usernames": [u['username'] for u in users]}


# --- Preferences ---

@router.get("/preferences/colors")
async def get_all_user_colors(username: str = Depends(require_auth)):
    """Get all users' color preferences (for efficient message rendering)."""
    return get_all_user_preferences()


@router.get("/{target_username}/preferences", response_model=GetPreferencesResponse)
async def get_user_preferences_endpoint(
    target_username: str,
    username: str = Depends(get_username_from_token),
):
    """Get user preferences. Users can access their own, admins can access any."""
    if target_username != username:
        from ..database import get_db
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            if not row or row['role'] != 'admin':
                raise HTTPException(status_code=403, detail="Not authorized")

    prefs = get_user_preferences(target_username)
    if not prefs:
        raise HTTPException(status_code=404, detail="User not found")
    return GetPreferencesResponse(**prefs)


@router.put("/{target_username}/preferences", response_model=UpdatePreferencesResponse)
async def update_user_preferences_endpoint(
    target_username: str,
    request: UpdatePreferencesRequest,
    username: str = Depends(get_username_from_token),
):
    """Update user preferences. Users can update their own, admins can update any."""
    if target_username != username:
        from ..database import get_db
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            if not row or row['role'] != 'admin':
                raise HTTPException(status_code=403, detail="Not authorized")

    from ..database import get_db
    with get_db() as conn:
        cursor = conn.execute('SELECT username FROM users WHERE username = ?', (target_username,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="User not found")

    update_user_preferences(target_username, color=request.color, theme_color=request.theme_color, nickname=request.nickname)
    return UpdatePreferencesResponse(status="ok")


class UpdateRoleRequest(BaseModel):
    role: str


@router.put("/{username}/role")
async def set_role(
    username: str,
    request: UpdateRoleRequest,
    _: str = Depends(require_admin),
):
    """Set user role."""
    if request.role not in ['admin', 'moderator', 'user']:
        raise HTTPException(status_code=400, detail="Invalid role")
    if not set_user_role(username, request.role):
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "ok"}
