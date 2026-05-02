"""API endpoints for plugin management."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List, Dict

from ..dependencies import require_admin

# All plugins live in backend/plugins/
PLUGINS_DIR = Path(__file__).parent.parent.parent / "plugins"

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
    room_type_meta: Dict[str, Dict[str, str]] = {}
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
            # Prefer dynamically registered frontend assets (register.frontend frame);
            # fall back to the on-disk manifest for plugins that don't use it.
            entry = (conn.frontend_scripts[0] if conn.frontend_scripts
                     else manifest.get("entry", ""))
            styles = conn.frontend_styles or manifest.get("styles", [])
            result.append({
                "id": pid,
                "name": manifest.get("name", pid),
                "version": conn.version,
                "description": manifest.get("description", ""),
                "author": manifest.get("author", ""),
                "entry": entry,
                "permissions": list(conn.permissions),
                "hooks": manifest.get("hooks", {}),
                "enabled": True,
                "room_types": conn.room_types,
                "room_type_meta": conn.room_type_meta,
                "styles": styles,
                "bus_connected": True,
            })
        return result
    except Exception:
        return []


@router.get("", response_model=List[PluginInfo])
async def list_plugins():
    """List all plugins — combines bus-connected and filesystem-discovered plugins."""
    plugins = []

    # Bus-connected plugins (out-of-process, approved and running)
    bus_ids = set()
    for bus_info in _get_bus_plugins():
        bus_ids.add(bus_info["id"])
        try:
            plugins.append(PluginInfo(**{k: v for k, v in bus_info.items() if k != "bus_connected"}))
        except Exception as e:
            print(f"[Plugins] Failed to add bus plugin {bus_info['id']}: {e}")

    # Filesystem plugins not currently bus-connected (available but not running)
    if PLUGINS_DIR.exists():
        for plugin_dir in PLUGINS_DIR.iterdir():
            if plugin_dir.is_dir() and (plugin_dir / "manifest.json").exists():
                plugin_id = plugin_dir.name
                if plugin_id in bus_ids:
                    continue  # Already listed from bus
                try:
                    plugin_info = load_plugin_manifest(plugin_id)
                    plugin_info.enabled = False  # Not connected to bus
                    plugins.append(plugin_info)
                except Exception as e:
                    print(f"[Plugins] Failed to load plugin {plugin_id}: {e}")

    return plugins


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

    For bus-connected plugins: proxies to the plugin's HTTP server.
    Fallback: serves from the filesystem.

    Security:
        Only files within the plugin directory are allowed.
        Path traversal is prevented.
    """
    print(f"[Plugins] Serving file: plugin={plugin_id} path={file_path}")
    # Check if this is a bus-connected plugin first
    try:
        from ..main import app
        from .middleware import PluginAuthMiddleware
        plugin_bus = getattr(app.state, 'plugin_bus', None)
        if plugin_bus:
            conn = plugin_bus.get_plugin(plugin_id)
            if conn and conn.http_base_url and PluginAuthMiddleware._is_localhost_url(conn.http_base_url):
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
