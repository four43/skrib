"""API endpoints for plugin settings — server-scoped (admin) and user-scoped."""
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from typing import Any, Dict

from ..dependencies import require_admin, require_auth
from ..plugin_bus import settings as settings_service

router = APIRouter(prefix="/plugins/{plugin_id}/settings", tags=["plugin-settings"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SettingsUpdateRequest(BaseModel):
    """Partial settings update — only keys present are changed."""
    settings: Dict[str, Any]


# ---------------------------------------------------------------------------
# Schema endpoint (public to authenticated users)
# ---------------------------------------------------------------------------

@router.get("/schema")
async def get_settings_schema(plugin_id: str, _: str = Depends(require_auth)):
    """Get the settings schema declared by a plugin."""
    schema = settings_service.get_settings_schema(plugin_id)
    return {"plugin_id": plugin_id, "settings": schema}


# ---------------------------------------------------------------------------
# Server-scoped settings (admin only)
# ---------------------------------------------------------------------------

@router.get("")
async def get_server_settings(plugin_id: str, admin: str = Depends(require_admin)):
    """Get current server-scoped settings for a plugin."""
    values = settings_service.get_server_settings(plugin_id)
    return {"plugin_id": plugin_id, "scope": "server", "settings": values}


@router.patch("")
async def update_server_settings(
    plugin_id: str,
    body: SettingsUpdateRequest,
    admin: str = Depends(require_admin),
):
    """Update server-scoped settings for a plugin (admin only).

    Sends a config.updated frame to the plugin for each changed key.
    """
    values = settings_service.update_server_settings(plugin_id, body.settings)

    # Notify the plugin of each changed setting
    for key, value in body.settings.items():
        await settings_service.notify_plugin_config_updated(plugin_id, key, value)

    return {"plugin_id": plugin_id, "scope": "server", "settings": values}


# ---------------------------------------------------------------------------
# User-scoped settings
# ---------------------------------------------------------------------------

@router.get("/user")
async def get_user_settings(plugin_id: str, username: str = Depends(require_auth)):
    """Get current user-scoped settings for a plugin."""
    values = settings_service.get_user_settings(plugin_id, username)
    return {"plugin_id": plugin_id, "scope": "user", "username": username, "settings": values}


@router.patch("/user")
async def update_user_settings(
    plugin_id: str,
    body: SettingsUpdateRequest,
    username: str = Depends(require_auth),
):
    """Update user-scoped settings for a plugin.

    Sends a config.updated frame to the plugin for each changed key.
    """
    values = settings_service.update_user_settings(plugin_id, username, body.settings)

    for key, value in body.settings.items():
        await settings_service.notify_plugin_config_updated(plugin_id, key, value)

    return {"plugin_id": plugin_id, "scope": "user", "username": username, "settings": values}
