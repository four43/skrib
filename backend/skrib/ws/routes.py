"""Unified WebSocket endpoint."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..dependencies import verify_token
from . import bus

router = APIRouter(tags=["ws"])


@router.websocket("/ws")
async def unified_ws(websocket: WebSocket, token: str | None = None):
    """Single WebSocket endpoint for all real-time communication."""
    print(f"[WS] Connection attempt from {websocket.client}, token={'present' if token else 'missing'}")

    if not token:
        print("[WS] Rejected: no token provided")
        await websocket.close(code=1008, reason="Authentication required")
        return

    username = verify_token(token)
    if not username:
        print(f"[WS] Rejected: invalid token")
        await websocket.close(code=1008, reason="Invalid token")
        return

    await websocket.accept()
    bus.connect(websocket, username)

    # Broadcast presence if this is the user's first connection
    if len(bus.user_connections.get(username, set())) == 1:
        await bus.notify_all_users({
            "type": "system:presence",
            "username": username,
            "connected": True,
        })

    try:
        await websocket.send_json({"type": "system:connected", "username": username})

        while True:
            raw = await websocket.receive_text()
            await bus.dispatch(websocket, username, raw)

    except WebSocketDisconnect:
        bus.disconnect(websocket)
        # Broadcast presence if user is now fully offline
        if username not in bus.user_connections:
            try:
                await bus.notify_all_users({
                    "type": "system:presence",
                    "username": username,
                    "connected": False,
                })
            except Exception:
                pass
    except Exception as e:
        print(f"[WS] Error for {username}: {e}")
        bus.disconnect(websocket)
        if username not in bus.user_connections:
            try:
                await bus.notify_all_users({
                    "type": "system:presence",
                    "username": username,
                    "connected": False,
                })
            except Exception:
                pass
