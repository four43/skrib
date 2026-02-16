"""Web Push plugin HTTP endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from mini_chat.dependencies import require_auth

router = APIRouter()

# Injected by plugin.py
services = None


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: dict  # {"p256dh": "...", "auth": "..."}


@router.get("/vapid-key")
async def get_vapid_key():
    """Return the VAPID public key for push subscription."""
    public_key, _ = services.get_or_create_vapid_keys()
    return {"public_key": public_key}


@router.post("/subscribe")
async def subscribe(body: SubscribeRequest, username: str = Depends(require_auth)):
    """Save a push subscription for the authenticated user."""
    p256dh = body.keys.get("p256dh")
    auth = body.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(status_code=400, detail="Missing p256dh or auth keys")

    services.save_subscription(username, body.endpoint, p256dh, auth)
    return {"ok": True}


@router.delete("/subscribe")
async def unsubscribe(body: SubscribeRequest, username: str = Depends(require_auth)):
    """Remove a push subscription for the authenticated user."""
    services.remove_subscription(username, body.endpoint)
    return {"ok": True}
