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
from ..database import set_setting
from ..dependencies import require_admin

router = APIRouter(prefix="/server", tags=["server"])


@router.get("", response_model=ServerInfoResponse)
async def get_server_info():
    """Get server info. Returns public server configuration."""
    status = get_system_status()
    return ServerInfoResponse(**status)


@router.patch("", response_model=ServerInfoResponse)
async def update_server(
    updates: ServerUpdateRequest,
    _: str = Depends(require_admin)
):
    """Update server properties (admin only)."""
    if updates.registration_mode is not None:
        set_registration_mode(updates.registration_mode)

    if updates.default_theme is not None:
        set_setting('default_theme', updates.default_theme)

    if updates.name is not None:
        set_setting('server_name', updates.name)

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
