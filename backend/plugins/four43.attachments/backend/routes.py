"""HTTP routes for file attachment operations."""
from pathlib import Path

from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.responses import Response, PlainTextResponse
from pydantic import BaseModel

from skrib.plugins.auth import plugin_user, check_room_access, get_user_role

from .services import AttachmentStore

PLUGIN_DIR = Path(__file__).resolve().parent.parent
CHUNK_SIZE = 5 * 1024 * 1024  # must match frontend CHUNK_SIZE

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


# --- Video streaming ---

@router.get("/sw-video.js")
async def serve_video_service_worker():
    """Serve the video-streaming Service Worker with Service-Worker-Allowed header.

    The SW must control the whole origin (scope '/') so it can intercept
    video Range requests made by <video> elements on /app.html.
    """
    sw_path = PLUGIN_DIR / "frontend" / "sw-video.js"
    if not sw_path.exists():
        raise HTTPException(status_code=404, detail="SW file not found")

    return Response(
        content=sw_path.read_bytes(),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@router.get("/attachments/{attachment_id}/playlist.m3u8")
async def get_playlist(
    attachment_id: str,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Generate an HLS-style m3u8 playlist for a video attachment.

    Each encrypted chunk is a segment.  Durations are estimated from
    chunk byte-sizes (the server cannot know real durations because data
    is end-to-end encrypted).  The playlist is consumed by the frontend
    video player which fetches and decrypts chunks on demand.
    """
    meta = store.get_meta(attachment_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Attachment not found")

    check_room_access(request, meta['room_id'])

    chunks = meta['chunks']
    if not chunks:
        raise HTTPException(status_code=400, detail="Attachment has no chunks")

    # Build relative chunk URLs and estimate durations.
    # Without decrypting, we can't know real media durations, so we use
    # a fixed target of 10 s per full-size chunk (reasonable for ~4 Mbps).
    target_duration = 10
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{target_duration}",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "",
    ]

    total_encrypted = sum(c['size'] for c in chunks)
    for chunk in chunks:
        proportion = chunk['size'] / total_encrypted if total_encrypted else 1
        est_duration = round(proportion * target_duration * len(chunks), 3)
        lines.append(f"#EXTINF:{est_duration},")
        lines.append(f"chunk/{chunk['chunk_index']}")

    lines.append("")
    lines.append("#EXT-X-ENDLIST")
    lines.append("")

    return PlainTextResponse(
        content="\n".join(lines),
        media_type="application/vnd.apple.mpegurl",
    )
