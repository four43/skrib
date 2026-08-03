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

def _plugin_info_from_registry(plugin_id: str, record: dict) -> Optional[PluginInfo]:
    """Merge a registry record's dynamic fields onto the on-disk manifest.

    Both runtimes' records share one key set (see plugins/registry.py), so
    this one function builds a PluginInfo for either — a bus-connected
    plugin or an in-process one — without needing to know which.
    """
    try:
        info = load_plugin_manifest(plugin_id)
    except HTTPException:
        return None
    info.version = record["version"]
    info.permissions = record["permissions"]
    info.room_types = record["room_types"]
    info.room_type_meta = record["room_type_meta"]
    # Prefer dynamically registered frontend assets (a register.frontend frame,
    # or an in-process plugin's own declarations); fall back to the on-disk
    # manifest for plugins that don't use it.
    if record["frontend_scripts"]:
        info.entry = record["frontend_scripts"][0]
    if record["frontend_styles"]:
        info.styles = record["frontend_styles"]
    info.enabled = True
    return info


@router.get("", response_model=List[PluginInfo])
async def list_plugins():
    """List all plugins — combines active (bus-connected or in-process) and filesystem-discovered plugins."""
    from ..main import app
    registry = getattr(app.state, 'plugin_registry', None)

    plugins = []
    active_ids = set()
    for record in (registry.all() if registry else []):
        plugin_id = record["id"]
        info = _plugin_info_from_registry(plugin_id, record)
        if info is None:
            print(f"[Plugins] Active plugin {plugin_id} has no on-disk manifest, skipping")
            continue
        active_ids.add(plugin_id)
        plugins.append(info)

    # Filesystem plugins not currently active (available but not running)
    if PLUGINS_DIR.exists():
        for plugin_dir in PLUGINS_DIR.iterdir():
            if plugin_dir.is_dir() and (plugin_dir / "manifest.json").exists():
                plugin_id = plugin_dir.name
                if plugin_id in active_ids:
                    continue  # Already listed as active
                try:
                    plugin_info = load_plugin_manifest(plugin_id)
                    plugin_info.enabled = False  # Not active
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
    # Check if this is an active (bus-connected or in-process) plugin first
    try:
        from ..main import app
        from .middleware import PluginAuthMiddleware
        registry = getattr(app.state, 'plugin_registry', None)
        rec = registry.get(plugin_id) if registry else None
        http_base_url = rec["http_base_url"] if rec else None
        if http_base_url and PluginAuthMiddleware._is_localhost_url(http_base_url):
            import httpx
            url = f"{http_base_url.rstrip('/')}/file/{file_path}"
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
            print(f"[Plugins] Proxy returned {resp.status_code} for {file_path}, trying filesystem")
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
