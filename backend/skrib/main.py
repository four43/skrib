"""Main FastAPI application."""
import signal
import sys

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
from .plugins import registry
from .plugins.middleware import PluginAuthMiddleware
from .plugins.routes import router as plugins_router, fallback_router as plugins_fallback_router
from .plugins.core_api_routes import router as core_api_router
from .plugins.settings_routes import router as settings_router
from .admin.routes import router as admin_plugins_router
from .rooms.routes import router as rooms_router
from .rooms.services import load_rooms_from_db
from .server.routes import router as server_router
from .themes.routes import router as themes_router
from .users.routes import router as preferences_router
from .ws.routes import router as ws_router

# Initialize database and discover plugins at module level so that plugin
# routes are registered before the app starts serving requests.  Doing this
# in a startup event caused plugin routes to be added AFTER the catch-all
# static Mount("/"), resulting in 404s for plugin API endpoints.
init_db()
load_rooms_from_db()
registry.discover_plugins()

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
api.include_router(core_api_router)
api.include_router(settings_router)
api.include_router(admin_plugins_router)
api.include_router(themes_router)
api.include_router(backups_router)
api.include_router(log_router)

# Register plugin routes at module level, before the static catch-all mount
print("\n[Plugins] Initializing plugin system...")
for _plugin in registry.get_all_plugins():
    try:
        _plugin_router = _plugin.register_routes(app)
        if _plugin_router:
            # Add file/manifest routes to each plugin's sub-router so they
            # aren't shadowed by the sub-router's prefix match (Starlette
            # doesn't fall through to the fallback_router once a sub-router
            # with a matching prefix is entered).
            from .plugins.routes import get_plugin_file, load_plugin_manifest as _load_manifest

            @_plugin_router.get("/manifest", name=f"manifest_{_plugin.id}")
            async def _manifest(*, _pid=_plugin.id):
                return _load_manifest(_pid)

            @_plugin_router.get("/file/{file_path:path}", name=f"file_{_plugin.id}")
            async def _file(file_path: str, *, _pid=_plugin.id):
                return await get_plugin_file(_pid, file_path)

            api.include_router(_plugin_router, prefix=f"/plugins/{_plugin.id}")
            _route_names = [r.name for r in _plugin_router.routes if hasattr(r, 'name')]
            print(f"[Plugins] Registered routes for: {_plugin.id} at /api/plugins/{_plugin.id} "
                  f"({len(_plugin_router.routes)} routes: {_route_names})")
        else:
            print(f"[Plugins] No sub-router for: {_plugin.id} (will use fallback routes)")
    except Exception as _e:
        import traceback
        print(f"[Plugins] Failed to register routes for {_plugin.id}: {_e}")
        traceback.print_exc()

_all_info = registry.get_all_plugin_info()
print(f"[Plugins] Loaded {sum(1 for p in _all_info if p['enabled'])} plugins "
      f"({sum(1 for p in _all_info if not p['enabled'])} disabled)")

# Fallback parametric routes for plugins without sub-routers
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

    # Register plugin WebSocket namespaces (core controls the namespace name)
    from . import ws
    from .plugins.base import PluginBus
    from .plugins.callbacks import PluginCallbacks
    from .plugins.core_api import CoreAPI
    core_api = CoreAPI(bus=ws.bus)

    for plugin in registry.get_all_plugins():
        try:
            # Give every plugin a scoped bus so it can send outgoing messages
            # under its own namespace (e.g. "four43.room-type-chat:message")
            permissions = registry.get_plugin_permissions(plugin.id)
            plugin.bus = PluginBus(ws.bus, plugin.id, permissions=permissions)
            plugin.core_api = core_api
            plugin._callbacks = PluginCallbacks(plugin)
            plugin.register_callbacks(plugin._callbacks)

            ws_handler = plugin.get_ws_handler()
            if ws_handler:
                async def scoped_handler(bus, ws_conn, username, msg, _pb=plugin.bus, _h=ws_handler):
                    reply_to = bus.create_reply_token(ws_conn)
                    try:
                        await _h(_pb, reply_to, username, msg)
                    finally:
                        bus.invalidate_reply_token(reply_to)

                ws.bus.register_namespace(plugin.id, scoped_handler)
                print(f"[Plugins] Registered WebSocket namespace '{plugin.id}' for: {plugin.id}")
        except Exception as e:
            print(f"[Plugins] Failed to register WS for {plugin.id}: {e}")

    # Call on_startup for all plugins
    for plugin in registry.get_all_plugins():
        try:
            await plugin.on_startup()
        except Exception as e:
            print(f"[Plugins] Error in on_startup for {plugin.id}: {e}")

    # Start WebSocket heartbeat (periodic ping to detect dead connections)
    ws.bus.start_heartbeat()

    # Start Plugin Bus server (out-of-process plugin communication)
    from .config import PLUGIN_BUS_HOST, PLUGIN_BUS_PORT
    from .plugin_bus.server import PluginBusServer
    from .plugin_bus.bridge import PluginBusBridge
    from .plugin_bus.protocol import ApprovalStatus
    from .plugin_bus.approvals import check_plugin_approval
    from websockets.asyncio.server import serve as ws_serve

    async def _approve_plugin(plugin_id: str, manifest: dict) -> ApprovalStatus:
        status = check_plugin_approval(plugin_id, manifest)
        return ApprovalStatus({"approved": "approved", "pending": "pending_approval",
                               "rejected": "rejected", "disabled": "rejected"}[status])

    plugin_bus = PluginBusServer(approve_plugin=_approve_plugin)
    plugin_bus_server = await ws_serve(plugin_bus.handle_connection, PLUGIN_BUS_HOST, PLUGIN_BUS_PORT)
    app.state.plugin_bus = plugin_bus
    app.state.plugin_bus_server = plugin_bus_server

    # Create the bridge that translates between bus frames and the WS manager
    bridge = PluginBusBridge(plugin_bus, ws.bus, core_api)
    app.state.plugin_bus_bridge = bridge
    print(f"[PluginBus] Listening on ws://{PLUGIN_BUS_HOST}:{PLUGIN_BUS_PORT}")

    # Start backup scheduler
    from .backups.services import start_backup_scheduler
    await start_backup_scheduler()

    print()


@app.on_event("shutdown")
async def shutdown_event():
    """Call on_shutdown for all plugins, then auto-cleanup registered resources."""
    from . import ws
    ws.bus.stop_heartbeat()
    from .backups.services import stop_backup_scheduler
    stop_backup_scheduler()
    print("\n[Plugins] Shutting down plugins...")
    for plugin in registry.get_all_plugins():
        try:
            await plugin.on_shutdown()
        except Exception as e:
            print(f"[Plugins] Error in on_shutdown for {plugin.id}: {e}")
        try:
            await plugin._cleanup_all()
        except Exception as e:
            print(f"[Plugins] Error in cleanup for {plugin.id}: {e}")

    # Stop Plugin Bus bridge and server
    if hasattr(app.state, 'plugin_bus_bridge'):
        app.state.plugin_bus_bridge.teardown()
    if hasattr(app.state, 'plugin_bus_server'):
        app.state.plugin_bus_server.close()
        await app.state.plugin_bus_server.wait_closed()
        print("[PluginBus] Stopped")

    # Close all database connections on this thread to avoid ResourceWarnings
    from .database import close_all_connections
    from .plugins.base import close_all_plugin_connections
    close_all_connections()
    close_all_plugin_connections()


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
