"""HTTP server helper for out-of-process plugins.

Runs a FastAPI/Starlette app alongside the bus connection so plugins
can serve HTTP endpoints (routes) from their own process.
"""
from __future__ import annotations

import asyncio
import logging
import socket

from fastapi import FastAPI

logger = logging.getLogger(__name__)


def create_plugin_app(plugin_id: str, router=None) -> FastAPI:
    """Create a FastAPI app for a plugin's HTTP endpoints.

    The app expects the same x-skrib-* auth headers that the middleware
    injects when proxying requests.
    """
    app = FastAPI(title=f"Skrib Plugin: {plugin_id}", docs_url=None, redoc_url=None)

    if router:
        app.include_router(router)

    @app.get("/health")
    async def health():
        return {"status": "ok", "plugin_id": plugin_id}

    return app


async def run_http_server(app: FastAPI, host: str = "127.0.0.1", port: int = 0) -> tuple:
    """Start the HTTP server and return (server, actual_port).

    If port is 0, an ephemeral port is chosen automatically.
    """
    import uvicorn

    # Pre-bind a socket to discover the ephemeral port
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    actual_port = sock.getsockname()[1]
    sock.close()

    config = uvicorn.Config(app, host=host, port=actual_port, log_level="warning")
    server = uvicorn.Server(config)

    # Run in a background task
    task = asyncio.create_task(server.serve())

    # Wait for the server to start accepting connections
    for _ in range(50):
        await asyncio.sleep(0.05)
        if server.started:
            break

    return server, actual_port
