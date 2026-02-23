"""Main FastAPI application."""
import signal
import sys

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Import routers
from .auth.routes import router as auth_router
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
from .plugins.routes import router as plugins_router
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

# Create FastAPI app
app = FastAPI(title=APP_TITLE, version=APP_VERSION)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=CORS_ALLOW_CREDENTIALS,
    allow_methods=CORS_ALLOW_METHODS,
    allow_headers=CORS_ALLOW_HEADERS,
)

# Mount static files from Vite build
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

# Register API routers
app.include_router(auth_router, prefix="/api")
app.include_router(rooms_router, prefix="/api")
app.include_router(server_router, prefix="/api")
app.include_router(preferences_router, prefix="/api")
app.include_router(ws_router, prefix="/api")
app.include_router(plugins_router, prefix="/api")
app.include_router(themes_router, prefix="/api")

# Register plugin routes at module level, before the static catch-all mount
print("\n[Plugins] Initializing plugin system...")
for _plugin in registry.get_all_plugins():
    try:
        _plugin_router = _plugin.register_routes(app)
        if _plugin_router:
            app.include_router(_plugin_router, prefix=f"/api/plugins/{_plugin.id}")
            print(f"[Plugins] Registered routes for: {_plugin.id} at /api/plugins/{_plugin.id}")
    except Exception as _e:
        print(f"[Plugins] Failed to register routes for {_plugin.id}: {_e}")

_all_info = registry.get_all_plugin_info()
print(f"[Plugins] Loaded {sum(1 for p in _all_info if p['enabled'])} plugins "
      f"({sum(1 for p in _all_info if not p['enabled'])} disabled)")


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
    for plugin in registry.get_all_plugins():
        try:
            # Give every plugin a scoped bus so it can send outgoing messages
            # under its own namespace (e.g. "four43.room-type-chat:message")
            plugin.bus = PluginBus(ws.bus, plugin.id)

            ws_handler = plugin.get_ws_handler()
            if ws_handler:
                async def scoped_handler(bus, ws_conn, username, msg, _pb=plugin.bus, _h=ws_handler):
                    await _h(_pb, ws_conn, username, msg)

                ws.bus.register_namespace(plugin.id, scoped_handler)
                print(f"[Plugins] Registered WebSocket namespace '{plugin.id}' for: {plugin.id}")
            plugin.register_event_listeners(ws.bus)
        except Exception as e:
            print(f"[Plugins] Failed to register WS for {plugin.id}: {e}")

    # Call on_startup for all plugins
    for plugin in registry.get_all_plugins():
        try:
            await plugin.on_startup()
        except Exception as e:
            print(f"[Plugins] Error in on_startup for {plugin.id}: {e}")

    print()


@app.on_event("shutdown")
async def shutdown_event():
    """Call on_shutdown for all plugins."""
    print("\n[Plugins] Shutting down plugins...")
    for plugin in registry.get_all_plugins():
        try:
            await plugin.on_shutdown()
        except Exception as e:
            print(f"[Plugins] Error in on_shutdown for {plugin.id}: {e}")


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
