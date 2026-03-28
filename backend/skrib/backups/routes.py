"""Admin API routes for backups and system log."""
import os

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pathlib import Path

from .schemas import (
    BackupConfigResponse,
    BackupConfigUpdate,
    BackupListResponse,
    BackupTriggerResponse,
    SystemLogResponse,
)
from .services import (
    create_backup,
    delete_backup,
    get_backup_config,
    get_system_logs,
    list_backups,
    update_backup_config,
)
from ..dependencies import require_admin

router = APIRouter(prefix="/admin/backups", tags=["backups"])


@router.get("", response_model=BackupListResponse)
async def api_list_backups(_: str = Depends(require_admin)):
    """List all backups."""
    return BackupListResponse(backups=list_backups())


@router.post("", response_model=BackupTriggerResponse)
async def api_create_backup(username: str = Depends(require_admin)):
    """Trigger a manual backup."""
    try:
        result = create_backup(username=username)
        return BackupTriggerResponse(**result)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/config", response_model=BackupConfigResponse)
async def api_get_config(_: str = Depends(require_admin)):
    """Get backup configuration."""
    return BackupConfigResponse(**get_backup_config())


@router.patch("/config", response_model=BackupConfigResponse)
async def api_update_config(
    updates: BackupConfigUpdate,
    _: str = Depends(require_admin),
):
    """Update backup configuration."""
    result = update_backup_config(updates.model_dump(exclude_none=True))
    return BackupConfigResponse(**result)


@router.get("/{filename}")
async def api_download_backup(filename: str, _: str = Depends(require_admin)):
    """Download a backup zip file."""
    # Path traversal protection
    if os.path.basename(filename) != filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    config = get_backup_config()
    backup_dir = Path(config["directory"])
    path = backup_dir / filename

    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Backup not found")

    return FileResponse(
        path=str(path),
        media_type="application/zip",
        filename=filename,
    )


@router.delete("/{filename}")
async def api_delete_backup(filename: str, _: str = Depends(require_admin)):
    """Delete a specific backup."""
    if not delete_backup(filename):
        raise HTTPException(status_code=404, detail="Backup not found")
    return {"status": "deleted"}


# ── System log ─────────────────────────────────────────────────────────

log_router = APIRouter(prefix="/admin/logs", tags=["logs"])


@log_router.get("", response_model=SystemLogResponse)
async def api_get_logs(
    category: str = Query(None),
    level: str = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    _: str = Depends(require_admin),
):
    """Query system log entries."""
    result = get_system_logs(category=category, level=level, page=page, page_size=page_size)
    return SystemLogResponse(**result)
