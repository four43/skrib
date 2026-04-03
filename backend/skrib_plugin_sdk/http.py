"""HTTP server helper for out-of-process plugins.

Runs a FastAPI/Starlette app alongside the bus connection so plugins
can serve HTTP endpoints (routes) from their own process.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import uvicorn
from fastapi import FastAPI, Request, HTTPException

if TYPE_CHECKING:
    pass

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


async def run_http_server(app: FastAPI, host: str = "127.0.0.1", port: int = 0) -> tuple[asyncio.Server, int]:
    """Start the HTTP server and return (server, actual_port).

    If port is 0, an ephemeral port is chosen automatically.
    """
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    # Start serving without blocking
    await server.startup()

    # Get the actual bound port
    actual_port = port
    for sock in server.servers:
        for s in sock.sockets:
            addr = s.getsockname()
            actual_port = addr[1]
            break
        break

    return server, actual_port
