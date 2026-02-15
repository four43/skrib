"""Server info API routes."""
from fastapi import APIRouter, Depends, HTTPException, Request

from .schemas import (
    ServerInfoResponse,
    ServerUpdateRequest,
    InviteTokenListResponse,
    InviteTokenResponse,
    CreateInviteResponse,
)
from .services import (
    get_system_status,
    set_registration_mode,
    create_invite_token,
    get_invite_tokens,
    delete_invite_token,
)
from ..database import get_setting, set_setting
from ..dependencies import require_admin, get_username_from_token

router = APIRouter(prefix="/server", tags=["server"])


@router.get("", response_model=ServerInfoResponse)
async def get_server_info(username: str = Depends(get_username_from_token)):
    """Get server info. Public info (registration_mode, server_color) for all users, full stats for admins."""
    from ..auth.services import get_registration_mode
    from ..database import get_db

    # Get public info
    registration_mode = get_registration_mode()
    server_color = get_setting('server_color', '#6366f1') or '#6366f1'

    # Check if user is admin
    is_admin = False
    if username:
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            is_admin = row and row['role'] == 'admin'

    # Return full status for admins, basic info for others
    if is_admin:
        status = get_system_status()
        return ServerInfoResponse(**status)
    else:
        return ServerInfoResponse(
            registration_mode=registration_mode,
            server_color=server_color
        )


@router.patch("", response_model=ServerInfoResponse)
async def update_server(
    updates: ServerUpdateRequest,
    _: str = Depends(require_admin)
):
    """Update server properties (admin only)."""
    if updates.registration_mode is not None:
        set_registration_mode(updates.registration_mode)

    if updates.server_color is not None:
        set_setting('server_color', updates.server_color)

    # Return updated server info
    status = get_system_status()
    return ServerInfoResponse(**status)


@router.post("/invites", response_model=CreateInviteResponse)
async def create_invite(
    request: Request,
    admin_username: str = Depends(require_admin)
):
    """Create a new invite token (admin only)."""
    token = create_invite_token(admin_username)
    base_url = str(request.base_url).rstrip('/')
    invite_url = f"{base_url}/register.html?invite={token}"
    return CreateInviteResponse(token=token, invite_url=invite_url)


@router.get("/invites", response_model=InviteTokenListResponse)
async def list_invites(_: str = Depends(require_admin)):
    """List all invite tokens (admin only)."""
    tokens = get_invite_tokens()
    return InviteTokenListResponse(
        invites=[InviteTokenResponse(**t) for t in tokens]
    )


@router.delete("/invites/{token}")
async def remove_invite(token: str, _: str = Depends(require_admin)):
    """Delete an invite token (admin only)."""
    if not delete_invite_token(token):
        raise HTTPException(status_code=404, detail="Invite token not found")
    return {"status": "deleted"}
