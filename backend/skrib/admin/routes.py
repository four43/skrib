"""Admin API endpoints for plugin approval management."""
from fastapi import APIRouter, HTTPException, Depends

from ..dependencies import require_admin
from ..plugin_bus import approvals
from ..database import add_system_log

router = APIRouter(prefix="/admin/plugins", tags=["admin-plugins"])


def _get_bus_server():
    """Get the plugin bus server from app state."""
    try:
        from ..main import app
        return getattr(app.state, "plugin_bus", None)
    except Exception:
        return None


def _get_registry():
    """Get the runtime-agnostic plugin registry from app state."""
    try:
        from ..main import app
        return getattr(app.state, "plugin_registry", None)
    except Exception:
        return None


def _reject_if_in_process(plugin_id: str) -> None:
    """Raise 400 if ``plugin_id`` is an active in-process plugin.

    An in-process plugin can still carry a stale approval record — e.g. one
    left over from before it moved in-process, or created afresh on every
    startup by some approval flows. Rejecting or disabling it would call
    ``bus.deactivate_plugin`` as a no-op (that only ever affects bus
    connections) and return 200, leaving the admin UI showing the plugin as
    disabled while it keeps handling every room exactly as before. In-process
    plugins are enabled or disabled by their manifest's ``runtime`` key, not
    by approval state, so refuse the action instead of silently no-opping.
    """
    registry = _get_registry()
    record = registry.get(plugin_id) if registry else None
    if record is not None and record.get("runtime") == "in_process":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Plugin '{plugin_id}' runs in-process and is enabled or "
                "disabled via its manifest, not by approval state."
            ),
        )


# ---------------------------------------------------------------------------
# List endpoints
# ---------------------------------------------------------------------------

@router.get("/pending")
async def list_pending(admin: str = Depends(require_admin)):
    """List plugins awaiting approval."""
    records = approvals.list_by_status("pending")
    # Enrich with connection status
    bus = _get_bus_server()
    for r in records:
        r["connected"] = bool(bus and bus.get_plugin(r["plugin_id"]))
        r["manifest"] = _safe_json(r.pop("manifest_json", "{}"))
    return records


@router.get("/approved")
async def list_approved(admin: str = Depends(require_admin)):
    """List approved plugins."""
    records = approvals.list_by_status("approved")
    bus = _get_bus_server()
    for r in records:
        r["connected"] = bool(bus and bus.get_plugin(r["plugin_id"]))
        r["manifest"] = _safe_json(r.pop("manifest_json", "{}"))
    return records


@router.get("")
async def list_all(admin: str = Depends(require_admin)):
    """List all plugin approval records."""
    records = approvals.list_all()
    bus = _get_bus_server()
    for r in records:
        r["connected"] = bool(bus and bus.get_plugin(r["plugin_id"]))
        r["manifest"] = _safe_json(r.pop("manifest_json", "{}"))
    return records


# ---------------------------------------------------------------------------
# Action endpoints
# ---------------------------------------------------------------------------

@router.post("/{plugin_id}/approve")
async def approve_plugin(plugin_id: str, admin: str = Depends(require_admin)):
    """Approve a plugin. If connected and pending, activates it immediately."""
    record = approvals.get_approval(plugin_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")

    if record["status"] == "approved":
        raise HTTPException(status_code=400, detail="Plugin is already approved")

    if not approvals.approve_plugin(plugin_id, admin):
        raise HTTPException(status_code=500, detail="Failed to approve plugin")

    add_system_log("plugins", f"Plugin '{plugin_id}' approved", username=admin)

    # If the plugin is currently connected and pending, activate it
    bus = _get_bus_server()
    activated = False
    if bus:
        activated = await bus.activate_plugin(plugin_id)

    secret = approvals.get_plugin_secret(plugin_id)
    return {"plugin_id": plugin_id, "status": "approved", "activated": activated, "secret": secret}


@router.post("/{plugin_id}/reject")
async def reject_plugin(plugin_id: str, admin: str = Depends(require_admin)):
    """Reject a plugin. If connected, disconnects it."""
    record = approvals.get_approval(plugin_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")

    _reject_if_in_process(plugin_id)

    if not approvals.reject_plugin(plugin_id):
        raise HTTPException(status_code=500, detail="Failed to reject plugin")

    add_system_log("plugins", f"Plugin '{plugin_id}' rejected", username=admin)

    # Disconnect if connected
    bus = _get_bus_server()
    if bus:
        await bus.deactivate_plugin(plugin_id, reason="rejected")

    return {"plugin_id": plugin_id, "status": "rejected"}


@router.post("/{plugin_id}/disable")
async def disable_plugin(plugin_id: str, admin: str = Depends(require_admin)):
    """Disable an approved plugin. Disconnects it if connected."""
    record = approvals.get_approval(plugin_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")

    if record["status"] != "approved":
        raise HTTPException(status_code=400, detail="Can only disable approved plugins")

    _reject_if_in_process(plugin_id)

    if not approvals.disable_plugin(plugin_id):
        raise HTTPException(status_code=500, detail="Failed to disable plugin")

    add_system_log("plugins", f"Plugin '{plugin_id}' disabled", username=admin)

    bus = _get_bus_server()
    if bus:
        await bus.deactivate_plugin(plugin_id, reason="disabled")

    return {"plugin_id": plugin_id, "status": "disabled"}


@router.delete("/{plugin_id}")
async def delete_approval(plugin_id: str, admin: str = Depends(require_admin)):
    """Drop a plugin's approval record. Disconnects it if currently connected.

    Use this to clear stale ``pending`` entries from plugins that connected
    once, were never approved, and won't return.
    """
    record = approvals.get_approval(plugin_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")

    bus = _get_bus_server()
    if bus and bus.get_plugin(plugin_id):
        await bus.deactivate_plugin(plugin_id, reason="approval_deleted")

    if not approvals.delete_approval(plugin_id):
        raise HTTPException(status_code=500, detail="Failed to delete approval record")

    add_system_log("plugins", f"Plugin '{plugin_id}' approval record deleted", username=admin)
    return {"plugin_id": plugin_id, "deleted": True}


@router.get("/{plugin_id}/manifest-diff")
async def get_manifest_diff(plugin_id: str, admin: str = Depends(require_admin)):
    """Get the stored manifest for a plugin (for review/diff)."""
    diff = approvals.get_manifest_diff(plugin_id)
    if not diff:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")
    return diff


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_json(s: str) -> dict:
    """Parse JSON string, returning empty dict on failure."""
    import json
    try:
        return json.loads(s)
    except Exception:
        return {}
