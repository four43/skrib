"""API routes for room folders."""
from fastapi import APIRouter, Depends, HTTPException

from ..dependencies import require_auth
from ..permissions import get_global_role
from . import services
from .schemas import (
    CreateFolderRequest,
    CreateFolderResponse,
    FolderTreeResponse,
    FolderInfo,
    MoveRoomRequest,
    ReorderRequest,
    RoomPosition,
    UpdateFolderRequest,
)

router = APIRouter(prefix="/room-folders", tags=["room-folders"])


def _require_admin_or_mod(username: str):
    """Raise 403 unless user is admin or moderator."""
    role = get_global_role(username)
    if role not in ('admin', 'moderator'):
        raise HTTPException(status_code=403, detail="Admin or moderator required")


@router.get("", response_model=FolderTreeResponse)
async def get_folder_tree(username: str = Depends(require_auth)):
    """Get the full folder tree and room positions."""
    folders = services.get_all_folders()
    room_positions = services.get_room_positions()
    return FolderTreeResponse(
        folders=[FolderInfo(**f) for f in folders],
        room_positions=[RoomPosition(**r) for r in room_positions],
    )


@router.post("", response_model=CreateFolderResponse)
async def create_folder(
    request: CreateFolderRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    try:
        folder_id = services.create_folder(
            name=request.name,
            parent_folder_id=request.parent_folder_id,
            created_by=username,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await _broadcast_folder_update()
    return CreateFolderResponse(folder_id=folder_id)


@router.patch("/{folder_id}")
async def update_folder(
    folder_id: str,
    request: UpdateFolderRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)

    kwargs = {}
    if request.name is not None:
        kwargs['name'] = request.name
    if request.position is not None:
        kwargs['position'] = request.position
    # parent_folder_id: use sentinel logic -- only pass if explicitly provided in the JSON
    raw = request.model_dump(exclude_unset=True)
    if 'parent_folder_id' in raw:
        kwargs['parent_folder_id'] = request.parent_folder_id
    else:
        kwargs['parent_folder_id'] = services._SENTINEL

    try:
        found = services.update_folder(folder_id, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not found:
        raise HTTPException(status_code=404, detail="Folder not found")

    await _broadcast_folder_update()
    return {"ok": True}


@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: str,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    if not services.delete_folder(folder_id):
        raise HTTPException(status_code=404, detail="Folder not found")

    await _broadcast_folder_update()
    return {"ok": True}


@router.put("/rooms/{room_id}")
async def move_room(
    room_id: str,
    request: MoveRoomRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    try:
        services.move_room(room_id, request.folder_id, request.position)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await _broadcast_folder_update()
    return {"ok": True}


@router.post("/reorder")
async def reorder(
    request: ReorderRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    folder_dicts = [f.model_dump() for f in request.folders]
    room_dicts = [r.model_dump() for r in request.rooms]
    services.batch_reorder(folder_dicts, room_dicts)

    await _broadcast_folder_update()
    return {"ok": True}


async def _broadcast_folder_update():
    """Broadcast folder update to all connected users."""
    from .. import ws
    await ws.bus.notify_all_users({"type": "room:folders_updated"})
