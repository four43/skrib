"""Unified WebSocket endpoint."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..dependencies import verify_token
from . import bus

router = APIRouter(tags=["ws"])


@router.websocket("/ws")
async def unified_ws(websocket: WebSocket, token: str | None = None):
    """Single WebSocket endpoint for all real-time communication."""
    if not token:
        await websocket.close(code=1008, reason="Authentication required")
        return

    username = verify_token(token)
    if not username:
        await websocket.close(code=1008, reason="Invalid token")
        return

    await websocket.accept()
    bus.connect(websocket, username)

    try:
        await websocket.send_json({"type": "system:connected", "username": username})

        while True:
            raw = await websocket.receive_text()
            await bus.dispatch(websocket, username, raw)

    except WebSocketDisconnect:
        bus.disconnect(websocket)
    except Exception as e:
        print(f"[WS] Error for {username}: {e}")
        bus.disconnect(websocket)
