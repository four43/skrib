"""REST API endpoints for emoji picker plugin."""
from fastapi import APIRouter, Depends, HTTPException, File, Form, UploadFile
from fastapi.responses import FileResponse

from skrib.plugins.auth import plugin_user, get_user_role

from . import services
from .schemas import CustomEmojiOut, CustomEmojiUpdate

router = APIRouter(prefix="/custom-emoji", tags=["Plugin: four43/emoji-picker"])


@router.get("", response_model=list[CustomEmojiOut])
async def list_emoji(username: str = Depends(plugin_user)):
    """List all custom emoji."""
    return services.list_custom_emoji()


@router.get("/{shortcode}")
async def get_emoji_image(shortcode: str, username: str = Depends(plugin_user)):
    """Serve a custom emoji image file."""
    file_path = services.get_emoji_file_path(shortcode)
    if not file_path:
        raise HTTPException(status_code=404, detail="Emoji not found")

    meta = services.get_custom_emoji(shortcode)
    return FileResponse(
        path=str(file_path),
        media_type=meta["content_type"],
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.post("", response_model=CustomEmojiOut, status_code=201)
async def upload_emoji(
    shortcode: str = Form(...),
    display_name: str = Form(...),
    category: str = Form("custom"),
    file: UploadFile = File(...),
    username: str = Depends(plugin_user),
    user_role: str = Depends(get_user_role),
):
    """Upload a new custom emoji (admin only)."""
    if user_role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can upload custom emoji")

    file_data = await file.read()

    try:
        return services.create_custom_emoji(
            shortcode=shortcode,
            display_name=display_name,
            file_data=file_data,
            content_type=file.content_type,
            category=category,
            uploaded_by=username,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{shortcode}", response_model=CustomEmojiOut)
async def update_emoji(
    shortcode: str,
    body: CustomEmojiUpdate,
    username: str = Depends(plugin_user),
    user_role: str = Depends(get_user_role),
):
    """Update custom emoji metadata (admin only)."""
    if user_role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can update custom emoji")

    result = services.update_custom_emoji(shortcode, body.display_name, body.category)
    if not result:
        raise HTTPException(status_code=404, detail="Emoji not found")
    return result


@router.delete("/{shortcode}", status_code=204)
async def delete_emoji(
    shortcode: str,
    username: str = Depends(plugin_user),
    user_role: str = Depends(get_user_role),
):
    """Delete a custom emoji (admin only)."""
    if user_role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can delete custom emoji")

    if not services.delete_custom_emoji(shortcode):
        raise HTTPException(status_code=404, detail="Emoji not found")
