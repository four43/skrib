"""HTTP routes for file attachment operations."""
from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from skrib.plugins.auth import plugin_user, check_room_access, get_user_role

from .services import AttachmentStore

# Injected by plugin.py after module load
core_api = None
store = AttachmentStore()

router = APIRouter(tags=["Plugin: four43/attachments"])


# --- Schemas ---

class InitUploadRequest(BaseModel):
    key_epoch: int


class InitUploadResponse(BaseModel):
    attachment_id: str


class FinalizeRequest(BaseModel):
    chunk_count: int


# --- Endpoints ---

@router.post("/rooms/{room_id}/attachments/init", response_model=InitUploadResponse)
async def init_upload(
    room_id: str,
    body: InitUploadRequest,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Start a new attachment upload for a room."""
    check_room_access(request, room_id)
    attachment_id = store.create_attachment(room_id, username, body.key_epoch)
    return InitUploadResponse(attachment_id=attachment_id)


@router.put("/attachments/{attachment_id}/chunk/{chunk_index}")
async def upload_chunk(
    attachment_id: str,
    chunk_index: int,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Upload a single encrypted chunk."""
    att = store.get_attachment(attachment_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if att['status'] != 'pending':
        raise HTTPException(status_code=400, detail="Attachment already finalized")
    if att['username'] != username:
        raise HTTPException(status_code=403, detail="Not the uploader")

    iv = request.headers.get('X-Chunk-IV')
    if not iv:
        raise HTTPException(status_code=400, detail="Missing X-Chunk-IV header")

    data = await request.body()
    store.store_chunk(attachment_id, chunk_index, data, iv)
    return {"ok": True}


@router.post("/attachments/{attachment_id}/finalize")
async def finalize_upload(
    attachment_id: str,
    body: FinalizeRequest,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Finalize an attachment upload after all chunks are uploaded."""
    att = store.get_attachment(attachment_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if att['status'] != 'pending':
        raise HTTPException(status_code=400, detail="Attachment already finalized")
    if att['username'] != username:
        raise HTTPException(status_code=403, detail="Not the uploader")

    try:
        result = store.finalize(attachment_id, body.chunk_count)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return result


@router.get("/attachments/{attachment_id}/meta")
async def get_attachment_meta(
    attachment_id: str,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Get attachment metadata including chunk IVs."""
    meta = store.get_meta(attachment_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify room access
    check_room_access(request, meta['room_id'])
    return meta


@router.get("/attachments/{attachment_id}/chunk/{chunk_index}")
async def download_chunk(
    attachment_id: str,
    chunk_index: int,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Download a single encrypted chunk."""
    att = store.get_attachment(attachment_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if att['status'] != 'complete':
        raise HTTPException(status_code=400, detail="Attachment not finalized")

    check_room_access(request, att['room_id'])

    data = store.get_chunk_data(attachment_id, chunk_index)
    if data is None:
        raise HTTPException(status_code=404, detail="Chunk not found")

    return Response(content=data, media_type="application/octet-stream")


@router.delete("/attachments/{attachment_id}")
async def delete_attachment(
    attachment_id: str,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Delete an attachment (author or admin only)."""
    att = store.get_attachment(attachment_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")

    user_role = get_user_role(request)
    if att['username'] != username and user_role != 'admin':
        raise HTTPException(status_code=403, detail="Only the uploader or an admin can delete")

    store.delete_attachment(attachment_id)
    return {"ok": True}
