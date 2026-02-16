"""API endpoints for plugin management."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, Any, List, Dict
from .registry import registry
from ..dependencies import require_auth

router = APIRouter(prefix="/plugins", tags=["plugins"])

# Directory for plugins (zip-based bundles)
DISTRIBUTED_PLUGINS_DIR = Path(__file__).parent.parent.parent / "plugins"


# Schemas for plugin data endpoints
class PluginDataUpdate(BaseModel):
    """Request body for updating plugin data."""
    data: dict[str, Any]


@router.get("/manifest")
async def get_plugins_manifest():
    """Get manifest of all registered plugins with frontend assets.

    Returns:
        dict: Plugin manifest with list of plugins and their assets
    """
    return registry.get_manifest()


# ============================================================================
# Distributed Plugin System (ZIP-based bundles)
# ============================================================================

class DistributedPluginInfo(BaseModel):
    """Plugin manifest information for plugins."""
    id: str
    name: str
    version: str
    description: str
    author: str
    entry: str
    permissions: List[str]
    hooks: Dict[str, bool]


def get_distributed_plugin_dir(plugin_id: str) -> Path:
    """Get the directory path for a distributed plugin."""
    plugin_path = DISTRIBUTED_PLUGINS_DIR / plugin_id
    if not plugin_path.exists() or not plugin_path.is_dir():
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_id} not found")
    return plugin_path


def load_distributed_plugin_manifest(plugin_id: str) -> DistributedPluginInfo:
    """Load and parse a distributed plugin's manifest.json."""
    plugin_dir = get_distributed_plugin_dir(plugin_id)
    manifest_path = plugin_dir / "manifest.json"

    if not manifest_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Manifest not found for plugin {plugin_id}"
        )

    try:
        with open(manifest_path, 'r') as f:
            manifest_data = json.load(f)
        return DistributedPluginInfo(**manifest_data)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load manifest for {plugin_id}: {str(e)}"
        )


@router.get("/distributed", response_model=List[DistributedPluginInfo])
async def list_distributed_plugins():
    """List all available plugins.

    Returns:
        List[DistributedPluginInfo]: List of plugin manifests
    """
    if not DISTRIBUTED_PLUGINS_DIR.exists():
        return []

    plugins = []
    for plugin_dir in DISTRIBUTED_PLUGINS_DIR.iterdir():
        if plugin_dir.is_dir() and (plugin_dir / "manifest.json").exists():
            try:
                plugin_info = load_distributed_plugin_manifest(plugin_dir.name)
                plugins.append(plugin_info)
            except Exception as e:
                print(f"[Plugins] Failed to load plugin {plugin_dir.name}: {e}")
                continue

    return plugins


@router.get("/distributed/{plugin_id}/manifest")
async def get_distributed_plugin_manifest(plugin_id: str):
    """Get a distributed plugin's manifest.

    Args:
        plugin_id: ID of the plugin (e.g., 'com.four43.chat-typing')

    Returns:
        DistributedPluginInfo: Plugin manifest data
    """
    return load_distributed_plugin_manifest(plugin_id)


@router.get("/distributed/{plugin_id}/file/{file_path:path}")
async def get_distributed_plugin_file(plugin_id: str, file_path: str):
    """
    Serve a distributed plugin file (JS, CSS, etc.).

    Args:
        plugin_id: ID of the plugin (e.g., 'com.four43.chat-typing')
        file_path: Path to file relative to plugin directory

    Returns:
        FileResponse: The requested file

    Security:
        Only files within the plugin directory are allowed.
        Path traversal is prevented.
    """
    plugin_dir = get_distributed_plugin_dir(plugin_id)

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

    # Check if file exists
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
            "Cache-Control": "public, max-age=3600",  # Cache for 1 hour
        }
    )


@router.get("/{plugin_name}/config")
async def get_plugin_config(plugin_name: str):
    """Get configuration for a specific plugin.

    Args:
        plugin_name: Name of the plugin

    Returns:
        dict: Plugin configuration including frontend assets

    Raises:
        HTTPException: If plugin not found
    """
    plugin = registry.get_plugin(plugin_name)
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_name}' not found")

    assets = plugin.get_frontend_assets()
    return {
        "name": plugin.name,
        "version": plugin.version,
        "room_types": plugin.room_types,
        "capabilities": plugin.capabilities,
        "scripts": assets.get("scripts", []),
        "styles": assets.get("styles", []),
        "config": assets.get("config", {})
    }


@router.get("/{plugin_name}/assets/{file_path:path}")
async def get_plugin_asset(plugin_name: str, file_path: str):
    """Serve a plugin's frontend asset file.

    Args:
        plugin_name: Name of the plugin
        file_path: Path to the asset file relative to plugin's assets directory

    Returns:
        FileResponse: The requested asset file

    Raises:
        HTTPException: If plugin not found or file not found
    """
    plugin = registry.get_plugin(plugin_name)
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_name}' not found")

    # Get the plugin module's directory
    plugin_module_path = Path(__file__).parent

    # Construct path to the frontend assets
    # For built-in plugins, assets are in frontend/src/plugins/
    frontend_plugins_dir = plugin_module_path.parent.parent.parent / "frontend" / "src" / "plugins"
    asset_path = frontend_plugins_dir / file_path

    # Security: ensure the path is within the plugins directory
    try:
        asset_path = asset_path.resolve()
        frontend_plugins_dir = frontend_plugins_dir.resolve()
        if not str(asset_path).startswith(str(frontend_plugins_dir)):
            raise HTTPException(status_code=403, detail="Access denied")
    except Exception:
        raise HTTPException(status_code=403, detail="Invalid path")

    if not asset_path.exists():
        raise HTTPException(status_code=404, detail=f"Asset not found: {file_path}")

    # Determine media type based on extension
    media_type = "application/javascript" if file_path.endswith(".js") else None
    if file_path.endswith(".css"):
        media_type = "text/css"

    return FileResponse(str(asset_path), media_type=media_type)


@router.get("/{plugin_name}/data")
async def get_plugin_user_data(
    plugin_name: str,
    username: str = Depends(require_auth)
):
    """Get current user's data for a specific plugin.

    Args:
        plugin_name: Name of the plugin
        username: Current authenticated username

    Returns:
        dict: User's plugin data or empty dict if no data exists

    Raises:
        HTTPException: If plugin not found or doesn't support data storage
    """
    plugin = registry.get_plugin(plugin_name)
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_name}' not found")

    # Check if plugin has a table
    if not plugin.get_table_schema():
        raise HTTPException(
            status_code=400,
            detail=f"Plugin '{plugin_name}' does not support data storage"
        )

    # For generic plugins, return all rows for this user
    table = plugin._get_table_name()
    try:
        rows = plugin.execute_query(
            f"SELECT * FROM {table} WHERE username = ?",
            (username,)
        )
        return rows[0] if rows else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch plugin data: {str(e)}")


@router.put("/{plugin_name}/data")
async def update_plugin_user_data(
    plugin_name: str,
    update: PluginDataUpdate,
    username: str = Depends(require_auth)
):
    """Update current user's data for a specific plugin.

    Args:
        plugin_name: Name of the plugin
        update: Data to update
        username: Current authenticated username

    Returns:
        dict: Success message

    Raises:
        HTTPException: If plugin not found or update fails
    """
    plugin = registry.get_plugin(plugin_name)
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_name}' not found")

    if not plugin.get_table_schema():
        raise HTTPException(
            status_code=400,
            detail=f"Plugin '{plugin_name}' does not support data storage"
        )

    # For generic plugins, the plugin should handle its own data structure
    raise HTTPException(
        status_code=400,
        detail=f"Plugin '{plugin_name}' does not support generic data updates"
    )


@router.delete("/{plugin_name}/data")
async def delete_plugin_user_data(
    plugin_name: str,
    username: str = Depends(require_auth)
):
    """Delete current user's data for a specific plugin (revert to defaults).

    Args:
        plugin_name: Name of the plugin
        username: Current authenticated username

    Returns:
        dict: Success message

    Raises:
        HTTPException: If plugin not found or deletion fails
    """
    plugin = registry.get_plugin(plugin_name)
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_name}' not found")

    if not plugin.get_table_schema():
        raise HTTPException(
            status_code=400,
            detail=f"Plugin '{plugin_name}' does not support data storage"
        )

    # For generic plugins, delete all user rows
    table = plugin._get_table_name()
    try:
        plugin.execute_write(
            f"DELETE FROM {table} WHERE username = ?",
            (username,)
        )
        return {"message": "Plugin data deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete plugin data: {str(e)}")
