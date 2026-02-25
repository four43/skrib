"""Server info API routes."""
import io

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import Response
from PIL import Image

from .schemas import (
    ServerInfoResponse,
    ServerUpdateRequest,
    InviteTokenResponse,
    CreateInviteResponse,
)
from .services import (
    get_system_status,
    set_registration_mode,
    create_invite_token,
    get_invite_tokens,
    delete_invite_token,
    get_server_icon,
    set_server_icon,
    reset_server_icon,
    is_server_icon_custom,
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
        # If using auto-generated icon, it will regenerate on next request
        # since it's based on the server name (no cached file when not custom)
        if not is_server_icon_custom():
            reset_server_icon()

    # Return updated server info
    status = get_system_status()
    return ServerInfoResponse(**status)


# --- Server icon ---

MAX_ICON_SIZE = 2 * 1024 * 1024  # 2 MB
ICON_DIMENSION = 128


@router.get("/icon")
async def get_icon():
    """Get server icon image. Public endpoint (no auth required)."""
    icon_data = get_server_icon()
    return Response(
        content=icon_data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.put("/icon")
async def upload_icon(
    file: UploadFile = File(...),
    _: str = Depends(require_admin),
):
    """Upload a custom server icon (admin only). Accepts PNG, JPEG, GIF, or WebP."""
    if file.content_type not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        raise HTTPException(status_code=400, detail="Image must be PNG, JPEG, GIF, or WebP")

    data = await file.read()
    if len(data) > MAX_ICON_SIZE:
        raise HTTPException(status_code=400, detail="Image must be under 2 MB")

    # Resize to standard icon size and convert to PNG
    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGBA")
        img = img.resize((ICON_DIMENSION, ICON_DIMENSION), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_data = buf.getvalue()
    except Exception:
        raise HTTPException(status_code=400, detail="Could not process image")

    set_server_icon(png_data)
    return {"status": "uploaded", "custom": True}


@router.delete("/icon")
async def delete_icon(_: str = Depends(require_admin)):
    """Reset server icon to auto-generated (admin only)."""
    reset_server_icon()
    return {"status": "reset", "custom": False}


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


@router.get("/invites", response_model=list[InviteTokenResponse])
async def list_invites(_: str = Depends(require_admin)):
    """List all invite tokens (admin only)."""
    tokens = get_invite_tokens()
    return [InviteTokenResponse(**t) for t in tokens]


@router.delete("/invites/{token}")
async def remove_invite(token: str, _: str = Depends(require_admin)):
    """Delete an invite token (admin only)."""
    if not delete_invite_token(token):
        raise HTTPException(status_code=404, detail="Invite token not found")
    return {"status": "deleted"}
