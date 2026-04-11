"""
Minimal WebRTC signaling server.

Pairs clients into rooms of 2 for P2P video calls.
Run: python server.py
Then open http://localhost:8080 in two browser tabs.
"""

import asyncio
import json
import pathlib
from aiohttp import web

ROOT = pathlib.Path(__file__).parent

# room_id -> list of websockets
rooms: dict[str, list[web.WebSocketResponse]] = {}


async def index(request):
    return web.FileResponse(ROOT / "index.html")


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    room_id = request.query.get("room", "default")

    if room_id not in rooms:
        rooms[room_id] = []

    room = rooms[room_id]

    if len(room) >= 2:
        await ws.send_json({"type": "error", "message": "Room is full"})
        await ws.close()
        return ws

    room.append(ws)
    peer_index = len(room) - 1
    print(f"[room={room_id}] Peer {peer_index} joined ({len(room)}/2)")

    # Tell this client whether to create the offer
    await ws.send_json({"type": "role", "role": "caller" if len(room) == 2 else "callee"})

    # If second peer joined, tell the first peer to start the call
    if len(room) == 2:
        await room[0].send_json({"type": "peer-joined"})

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                data = json.loads(msg.data)
                # Forward signaling messages to the other peer
                for other in room:
                    if other is not ws and not other.closed:
                        await other.send_json(data)
            elif msg.type == web.WSMsgType.ERROR:
                print(f"WebSocket error: {ws.exception()}")
    finally:
        room.remove(ws)
        print(f"[room={room_id}] Peer left ({len(room)}/2)")
        # Notify remaining peer
        for other in room:
            if not other.closed:
                await other.send_json({"type": "peer-left"})
        if not room:
            del rooms[room_id]

    return ws


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/ws", websocket_handler)

if __name__ == "__main__":
    print("Signaling server running at http://localhost:8080")
    print("Open in two browser tabs to test video chat.")
    web.run_app(app, host="0.0.0.0", port=8080)
