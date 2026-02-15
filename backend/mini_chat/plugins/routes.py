"""API endpoints for plugin management."""
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from .registry import registry

router = APIRouter(prefix="/plugins", tags=["plugins"])


@router.get("/manifest")
async def get_plugins_manifest():
    """Get manifest of all registered plugins with frontend assets.

    Returns:
        dict: Plugin manifest with list of plugins and their assets
    """
    return registry.get_manifest()


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
