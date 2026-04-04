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

def _get_bus_plugins() -> list[dict]:
    """Get plugin info for bus-connected plugins."""
    try:
        from ..main import app
        plugin_bus = getattr(app.state, 'plugin_bus', None)
        if not plugin_bus:
            return []
        result = []
        for pid, conn in plugin_bus.plugins.items():
            manifest = conn.manifest
            result.append({
                "id": pid,
                "name": manifest.get("name", pid),
                "version": conn.version,
                "description": manifest.get("description", ""),
                "author": manifest.get("author", ""),
                "entry": "",  # served via bus
                "permissions": list(conn.permissions),
                "hooks": manifest.get("hooks", {}),
                "enabled": True,
                "room_types": conn.room_types,
                "styles": conn.frontend_styles,
                "bus_connected": True,
            })
        return result
    except Exception:
        return []


@router.get("", response_model=List[PluginInfo])
async def list_plugins():
    """List all plugins with their manifests and enabled state."""
    plugins = []

    # In-process plugins (from filesystem)
    if PLUGINS_DIR.exists():
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
                    plugins.append(plugin_info)
                except Exception as e:
                    print(f"[Plugins] Failed to load plugin {plugin_id}: {e}")
                    continue

    # Bus-connected plugins (out-of-process) — only add if not already listed
    in_process_ids = {p.id for p in plugins}
    for bus_info in _get_bus_plugins():
        if bus_info["id"] not in in_process_ids:
            try:
                plugins.append(PluginInfo(**{k: v for k, v in bus_info.items() if k != "bus_connected"}))
            except Exception as e:
                print(f"[Plugins] Failed to add bus plugin {bus_info['id']}: {e}")

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
# Parametric routes — separate router so they can be registered AFTER
# plugin-specific sub-routers (otherwise Starlette's prefix matching
# enters a plugin sub-router and 404s without falling back to these).
# ============================================================================

fallback_router = APIRouter(prefix="/plugins", tags=["plugins"])


@fallback_router.get("/{plugin_id}/manifest")
async def get_plugin_manifest(plugin_id: str):
    """Get a plugin's manifest."""
    return load_plugin_manifest(plugin_id)


@fallback_router.get("/{plugin_id}/file/{file_path:path}")
async def get_plugin_file(plugin_id: str, file_path: str):
    """Serve a plugin file (JS, CSS, etc.).

    For in-process plugins: serves from the filesystem.
    For bus-connected plugins: proxies to the plugin's HTTP server.

    Security:
        Only files within the plugin directory are allowed.
        Path traversal is prevented.
    """
    print(f"[Plugins] Serving file: plugin={plugin_id} path={file_path}")
    # Check if this is a bus-connected plugin first
    try:
        from ..main import app
        plugin_bus = getattr(app.state, 'plugin_bus', None)
        if plugin_bus:
            conn = plugin_bus.get_plugin(plugin_id)
            if conn and conn.http_base_url:
                import httpx
                url = f"{conn.http_base_url.rstrip('/')}/file/{file_path}"
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(url)
                if resp.status_code == 200:
                    from fastapi.responses import Response
                    return Response(
                        content=resp.content,
                        media_type=resp.headers.get("content-type", "application/octet-stream"),
                        headers={"Cache-Control": "no-cache"},
                    )
                # Fall through to filesystem serving if plugin HTTP server
                # doesn't have this file (e.g. static assets live on disk)
                print(f"[Plugins] Bus proxy returned {resp.status_code} for {file_path}, trying filesystem")
    except HTTPException:
        raise
    except Exception:
        pass  # Fall through to filesystem serving

    plugin_dir = get_plugin_dir(plugin_id)
    print(f"[Plugins] File lookup: dir={plugin_dir} file={file_path}")

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
            "Cache-Control": "no-cache",
        }
    )
