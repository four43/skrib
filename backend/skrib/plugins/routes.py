"""API endpoints for plugin management."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List, Dict
from .registry import registry, PLUGINS_DIR
from ..dependencies import require_admin

router = APIRouter(prefix="/plugins", tags=["plugins"])


class PluginInfo(BaseModel):
    """Plugin manifest information."""
    id: str
    name: str
    version: str
    description: str
    author: str
    entry: str
    permissions: List[str]
    hooks: Dict[str, bool]
    enabled: bool = True
    room_types: List[str] = []
    styles: List[str] = []


class PluginUpdate(BaseModel):
    """Request body for updating plugin settings."""
    enabled: Optional[bool] = None


def get_plugin_dir(plugin_id: str) -> Path:
    """Get the directory path for a plugin."""
    plugin_path = PLUGINS_DIR / plugin_id
    if not plugin_path.exists() or not plugin_path.is_dir():
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_id} not found")
    return plugin_path


def load_plugin_manifest(plugin_id: str) -> PluginInfo:
    """Load and parse a plugin's manifest.json."""
    plugin_dir = get_plugin_dir(plugin_id)
    manifest_path = plugin_dir / "manifest.json"

    if not manifest_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Manifest not found for plugin {plugin_id}"
        )

    try:
        with open(manifest_path, 'r') as f:
            manifest_data = json.load(f)
        return PluginInfo(**manifest_data)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load manifest for {plugin_id}: {str(e)}"
        )


# ============================================================================
# Plugin listing and admin endpoints (literal routes first)
# ============================================================================

@router.get("", response_model=List[PluginInfo])
async def list_plugins():
    """List all plugins with their manifests and enabled state."""
    if not PLUGINS_DIR.exists():
        return []

    plugins = []
    for plugin_dir in PLUGINS_DIR.iterdir():
        if plugin_dir.is_dir() and (plugin_dir / "manifest.json").exists():
            plugin_id = plugin_dir.name
            try:
                plugin_info = load_plugin_manifest(plugin_id)
                plugin_info.enabled = registry.is_plugin_enabled(plugin_id)
                # Enrich with runtime data from the loaded plugin instance
                plugin_instance = registry.get_plugin(plugin_id)
                if plugin_instance:
                    plugin_info.room_types = plugin_instance.room_types
                    assets = plugin_instance.get_frontend_assets()
                    plugin_info.styles = assets.get("styles", [])
                plugins.append(plugin_info)
            except Exception as e:
                print(f"[Plugins] Failed to load plugin {plugin_id}: {e}")
                continue

    return plugins


@router.patch("/{plugin_id}")
async def update_plugin(
    plugin_id: str,
    update: PluginUpdate,
    _: str = Depends(require_admin),
):
    """Update a plugin's settings (admin only).

    Changes take effect after server restart.
    """
    plugin_dir = PLUGINS_DIR / plugin_id
    if not plugin_dir.exists() or not plugin_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_id} not found")

    if update.enabled is not None:
        registry.set_plugin_enabled(plugin_id, update.enabled)

    plugin_info = load_plugin_manifest(plugin_id)
    plugin_info.enabled = registry.is_plugin_enabled(plugin_id)
    return plugin_info


# ============================================================================
# Parametric routes (must come after literal routes)
# ============================================================================

@router.get("/{plugin_id}/manifest")
async def get_plugin_manifest(plugin_id: str):
    """Get a plugin's manifest."""
    return load_plugin_manifest(plugin_id)


@router.get("/{plugin_id}/file/{file_path:path}")
async def get_plugin_file(plugin_id: str, file_path: str):
    """Serve a plugin file (JS, CSS, etc.).

    Security:
        Only files within the plugin directory are allowed.
        Path traversal is prevented.
    """
    plugin_dir = get_plugin_dir(plugin_id)

    # Resolve the requested file path and ensure it's within the plugin directory
    requested_file = (plugin_dir / file_path).resolve()

    # Security check: ensure the resolved path is within the plugin directory
    try:
        requested_file.relative_to(plugin_dir)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Access denied: path traversal not allowed"
        )

    if not requested_file.exists() or not requested_file.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"File {file_path} not found in plugin {plugin_id}"
        )

    # Determine content type based on extension
    content_type = "application/octet-stream"
    ext = requested_file.suffix.lower()
    if ext == ".js":
        content_type = "application/javascript"
    elif ext == ".json":
        content_type = "application/json"
    elif ext == ".css":
        content_type = "text/css"
    elif ext == ".html":
        content_type = "text/html"
    elif ext == ".md":
        content_type = "text/markdown"

    return FileResponse(
        requested_file,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=3600",
        }
    )
