"""Plugin auth helpers — read pre-authenticated context from request headers.

Plugins use these instead of importing from skrib.dependencies or skrib.permissions.
The PluginAuthMiddleware injects x-skrib-* headers before requests reach plugin endpoints.

For WebSocket handlers, auth context is passed as keyword arguments to handle_room_action.
"""
from fastapi import Request, HTTPException
from typing import Optional


def plugin_user(request: Request) -> str:
    """Get authenticated username from pre-auth headers.

    Use as a FastAPI dependency: ``username: str = Depends(plugin_user)``

    Raises:
        HTTPException(401): If not authenticated
    """
    username = request.headers.get("x-skrib-username")
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return username


def get_user_role(request: Request) -> str:
    """Get user's global role from pre-auth headers."""
    return request.headers.get("x-skrib-user-role", "user")


def get_room_role(request: Request) -> Optional[str]:
    """Get user's role in the current room. None if not a member."""
    return request.headers.get("x-skrib-room-role")


def require_room_member(request: Request) -> str:
    """Require authenticated user who is a room member.

    Use as a FastAPI dependency: ``username: str = Depends(require_room_member)``

    Raises:
        HTTPException(401): If not authenticated
        HTTPException(403): If not a room member
    """
    username = request.headers.get("x-skrib-username")
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not request.headers.get("x-skrib-room-role"):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    return username


def check_room_access(request: Request, room_id: str) -> str:
    """Validate room access — DMs require membership, channels allow any authenticated user.

    Replaces ``skrib.permissions.check_room_access`` for plugin routes.

    Returns:
        Authenticated username

    Raises:
        HTTPException(401): If not authenticated
        HTTPException(403): If DM and not a member
    """
    username = plugin_user(request)
    if room_id.startswith("dm|") and not request.headers.get("x-skrib-room-role"):
        raise HTTPException(status_code=403, detail="Not a member of this DM")
    return username


def can_edit_resource(
    username: str,
    creator: str,
    room_role: Optional[str] = None,
    global_role: str = "user",
) -> bool:
    """Check if user can edit a resource. Computed locally from auth context.

    Logic: creator OR room owner/op OR global admin/moderator.
    """
    if username == creator:
        return True
    if room_role in ("owner", "op"):
        return True
    if global_role in ("admin", "moderator"):
        return True
    return False


def require_edit_permission(
    username: str,
    creator: str,
    room_role: Optional[str] = None,
    global_role: str = "user",
):
    """Raise 403 if user cannot edit the resource."""
    if not can_edit_resource(username, creator, room_role, global_role):
        raise HTTPException(
            status_code=403,
            detail="Only the creator, room ops, or admins can edit this item",
        )
