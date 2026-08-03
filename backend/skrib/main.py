"""Main FastAPI application."""
import os
import signal
import sys

from ._timing import mark as _t
_t("main.py import begin")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

# Import routers
from .auth.routes import router as auth_router
from .backups.routes import router as backups_router, log_router
from .config import (
    APP_TITLE,
    APP_VERSION,
    CORS_ALLOW_CREDENTIALS,
    CORS_ALLOW_HEADERS,
    CORS_ALLOW_METHODS,
    CORS_ORIGINS,
    FALLBACK_STATIC,
    STATIC_DIR,
)
from .database import init_db

# Import plugin system
from .plugins.middleware import PluginAuthMiddleware
from .plugins.routes import router as plugins_router, fallback_router as plugins_fallback_router
from .plugins.settings_routes import router as settings_router
from .admin.routes import router as admin_plugins_router
from .rooms.routes import router as rooms_router
from .rooms.services import load_rooms_from_db
from .server.routes import router as server_router
from .themes.routes import router as themes_router
from .users.routes import router as preferences_router
from .ws.routes import router as ws_router

_t("imports done")

# Initialize database at module level
init_db()
_t("init_db done")
load_rooms_from_db()
_t("load_rooms_from_db done")

# Create top-level app (no docs here — docs live under /api)
app = FastAPI(title=APP_TITLE, version=APP_VERSION, docs_url=None, redoc_url=None)

# API sub-application — mounted at /api, so docs are at /api/docs
api = FastAPI(title=APP_TITLE, version=APP_VERSION)

# Add CORS middleware (both apps — sub-app has its own middleware stack)
for _app in (app, api):
    _app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=CORS_ALLOW_CREDENTIALS,
        allow_methods=CORS_ALLOW_METHODS,
        allow_headers=CORS_ALLOW_HEADERS,
    )
    _app.add_middleware(GZipMiddleware, minimum_size=500)

# Pre-authenticate requests to plugin routes (injects x-skrib-* headers)
api.add_middleware(PluginAuthMiddleware)

# Cache-Control headers for slow-changing API endpoints and immutable assets
_CACHEABLE_API_PATHS = {
    "/server": "private, max-age=300",         # 5 min
    "/plugins": "private, max-age=300",         # 5 min
    "/users": "private, max-age=60",  # 1 min
}


@app.middleware("http")
async def add_cache_headers_assets(request, call_next):
    response = await call_next(request)
    # Immutable hashed assets from Vite build
    if request.url.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@api.middleware("http")
async def add_cache_headers_api(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path in _CACHEABLE_API_PATHS:
        response.headers.setdefault("Cache-Control", _CACHEABLE_API_PATHS[path])
    return response


# Mount static files from Vite build
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

# Register API routers
api.include_router(auth_router)
api.include_router(rooms_router)
api.include_router(server_router)
api.include_router(preferences_router)
api.include_router(ws_router)
api.include_router(plugins_router)
api.include_router(settings_router)
api.include_router(admin_plugins_router)
api.include_router(themes_router)
api.include_router(backups_router)
api.include_router(log_router)

# Plugin routes — out-of-process plugins serve their own HTTP via middleware proxy;
# fallback router handles manifest/file serving from filesystem
api.include_router(plugins_fallback_router)


# Mount API sub-app — docs at /api/docs, redoc at /api/redoc
app.mount("/api", api)


@app.get("/")
async def read_root():
    """Serve the main HTML file."""
    static_index = STATIC_DIR / "index.html"
    if static_index.exists():
        return FileResponse(str(static_index))

    # Fallback for development
    fallback = FALLBACK_STATIC / "index.html"
    if fallback.exists():
        return FileResponse(str(fallback))

    raise HTTPException(status_code=404, detail="Frontend not found")


# Catch-all static mount for production: serves manifest.json, sw.js, icons,
# and HTML pages from the Vite build output. Registered last so API routes
# and /assets take priority.
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static-root")


@app.on_event("startup")
async def startup_event():
    """Async plugin startup callbacks and status logging."""
    _t("startup_event begin")
    from .database import get_db, get_setting

    with get_db() as conn:
        cursor = conn.execute("SELECT COUNT(*) as count FROM users WHERE status = 'active'")
        user_count = cursor.fetchone()['count']

        cursor = conn.execute("SELECT COUNT(*) as count FROM users WHERE status = 'pending'")
        pending_count = cursor.fetchone()['count']

        reg_mode = get_setting('registration_mode', 'closed')

    from .rooms.services import ROOMS
    print(f"Loaded {len(ROOMS)} rooms")
    print(f"Users: {user_count}, Pending: {pending_count}")
    print(f"Registration mode: {reg_mode}")

    from . import ws
    from .plugins.core_api import CoreAPI
    core_api = CoreAPI(bus=ws.bus)

    # Start WebSocket heartbeat (periodic ping to detect dead connections)
    ws.bus.start_heartbeat()

    # Start Plugin Bus server (out-of-process plugin communication)
    from .config import PLUGIN_BUS_HOST, PLUGIN_BUS_PORT
    from .plugin_bus.server import PluginBusServer, MAX_MESSAGE_SIZE
    from .plugin_bus.bridge import PluginBusBridge
    from .plugin_bus.protocol import ApprovalStatus
    from .plugin_bus.approvals import check_plugin_approval, get_plugin_secret, sync_secret_files
    from websockets.asyncio.server import serve as ws_serve

    # Ensure secret files exist for all approved plugins (backfill)
    sync_secret_files()

    async def _approve_plugin(plugin_id: str, manifest: dict) -> ApprovalStatus:
        status = check_plugin_approval(plugin_id, manifest)
        return ApprovalStatus({"approved": "approved", "pending": "pending_approval",
                               "rejected": "rejected", "disabled": "rejected"}[status])

    # Tests can opt into a deterministic startup: every connecting plugin is
    # auto-approved, no secret check. Production must NOT set this.
    if os.environ.get("SKRIB_PLUGIN_AUTO_APPROVE"):
        async def _auto_approve(plugin_id: str, manifest: dict) -> ApprovalStatus:
            return ApprovalStatus.APPROVED
        plugin_bus = PluginBusServer(approve_plugin=_auto_approve, get_plugin_secret=None)
        print("[PluginBus] AUTO_APPROVE mode — every plugin connection is approved without secret check")
    else:
        plugin_bus = PluginBusServer(approve_plugin=_approve_plugin, get_plugin_secret=get_plugin_secret)
    bus_port = PLUGIN_BUS_PORT
    if os.environ.get("SKRIB_PLUGIN_BUS_PORT"):
        # Explicit bus port (e.g. E2E tests that start plugin processes)
        bus_port = int(os.environ["SKRIB_PLUGIN_BUS_PORT"])
    elif os.environ.get("SKRIB_DATA_DIR"):
        # Tests: use port 0 to let the OS assign a free port, avoiding conflicts
        bus_port = 0
    plugin_bus_server = await ws_serve(
        plugin_bus.handle_connection, PLUGIN_BUS_HOST, bus_port,
        max_size=MAX_MESSAGE_SIZE,
    )
    app.state.plugin_bus = plugin_bus
    app.state.plugin_bus_server = plugin_bus_server
    _t("plugin bus serving")

    # Create the bridge that translates between bus frames and the WS manager
    bridge = PluginBusBridge(plugin_bus, ws.bus, core_api)
    app.state.plugin_bus_bridge = bridge
    actual_port = plugin_bus_server.sockets[0].getsockname()[1] if plugin_bus_server.sockets else bus_port
    print(f"[PluginBus] Listening on ws://{PLUGIN_BUS_HOST}:{actual_port}")

    # Start backup scheduler
    from .backups.services import start_backup_scheduler
    await start_backup_scheduler()
    _t("startup_event done")

    print()


@app.on_event("shutdown")
async def shutdown_event():
    """Shut down the plugin bus and clean up resources."""
    from . import ws
    ws.bus.stop_heartbeat()
    from .backups.services import stop_backup_scheduler
    stop_backup_scheduler()

    # Stop Plugin Bus bridge and server
    if hasattr(app.state, 'plugin_bus_bridge'):
        app.state.plugin_bus_bridge.teardown()
    if hasattr(app.state, 'plugin_bus_server'):
        app.state.plugin_bus_server.close()
        await app.state.plugin_bus_server.wait_closed()
        print("[PluginBus] Stopped")

    # Close the shared proxy HTTP client
    from .plugins.middleware import close_http_client
    await close_http_client()

    # Close all database connections on this thread to avoid ResourceWarnings
    from .database import close_all_connections
    close_all_connections()


def signal_handler(sig, frame):
    """Handle shutdown signals."""
    print("\nShutting down chat server...")
    sys.exit(0)


if __name__ == "__main__":
    import uvicorn

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print("Starting Chat Server with FastAPI and SQLite...")

    uvicorn.run(app, host="localhost", port=8000)
