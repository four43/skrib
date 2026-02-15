"""Main FastAPI application."""
import signal
import sys
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import (
    APP_TITLE,
    APP_VERSION,
    CORS_ORIGINS,
    CORS_ALLOW_CREDENTIALS,
    CORS_ALLOW_METHODS,
    CORS_ALLOW_HEADERS,
    STATIC_DIR,
    FALLBACK_STATIC,
)
from .database import init_db
from .rooms.services import load_rooms_from_db

# Import routers
from .auth.routes import router as auth_router
from .rooms.routes import router as rooms_router
from .messages.routes import router as messages_router
from .server.routes import router as server_router
from .users.routes import router as preferences_router
from .ws.routes import router as ws_router

# Import plugin system
from .plugins import registry
from .plugins.routes import router as plugins_router
from .plugins.typing_plugin import TypingPlugin

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


@app.on_event("startup")
async def startup_event():
    """Initialize database and load rooms on startup."""
    init_db()
    load_rooms_from_db()

    # Count users
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

    # Initialize plugin system
    print("\n[Plugins] Initializing plugin system...")

    # Register built-in plugins
    try:
        typing_plugin = TypingPlugin()
        registry.register(typing_plugin)
    except Exception as e:
        print(f"[Plugins] Failed to register typing plugin: {e}")

    # Discover additional plugins
    # registry.discover_plugins()  # Uncomment to enable auto-discovery

    # Register plugin WebSocket namespaces
    from . import ws
    for plugin in registry.get_all_plugins():
        try:
            plugin.register_ws_namespace(ws.bus)
            print(f"[Plugins] Registered WebSocket namespace for: {plugin.name}")
        except Exception as e:
            print(f"[Plugins] Failed to register WS namespace for {plugin.name}: {e}")

    # Call on_startup for all plugins
    for plugin in registry.get_all_plugins():
        try:
            await plugin.on_startup()
        except Exception as e:
            print(f"[Plugins] Error in on_startup for {plugin.name}: {e}")

    print(f"[Plugins] Loaded {len(registry.get_all_plugins())} plugins")
    print()


@app.on_event("shutdown")
async def shutdown_event():
    """Call on_shutdown for all plugins."""
    print("\n[Plugins] Shutting down plugins...")
    for plugin in registry.get_all_plugins():
        try:
            await plugin.on_shutdown()
        except Exception as e:
            print(f"[Plugins] Error in on_shutdown for {plugin.name}: {e}")


# Register API routers
app.include_router(auth_router, prefix="/api")
app.include_router(rooms_router, prefix="/api")
app.include_router(messages_router, prefix="/api")
app.include_router(server_router, prefix="/api")
app.include_router(preferences_router, prefix="/api")
app.include_router(ws_router, prefix="/api")
app.include_router(plugins_router, prefix="/api")


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
