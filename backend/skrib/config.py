"""Configuration settings for the application."""
import os
from pathlib import Path

# Project root (backend directory)
BACKEND_ROOT = Path(__file__).parent.parent

# Database configuration
DB_DIR = Path(os.getenv('SKRIB_DATA_DIR', str(BACKEND_ROOT.parent / "data")))
DB_FILE = str(DB_DIR / "chat.db")
DB_TIMEOUT = 30.0  # 30 seconds timeout for busy database

# Ensure data directory exists
DB_DIR.mkdir(exist_ok=True)

# Static files
PROJECT_ROOT = BACKEND_ROOT.parent
STATIC_DIR = PROJECT_ROOT / "frontend" / "dist"
FALLBACK_STATIC = PROJECT_ROOT / "static"

# CORS settings
CORS_ORIGINS = ["*"]  # In production, specify allowed origins
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_METHODS = ["*"]
CORS_ALLOW_HEADERS = ["*"]

# Application settings
APP_TITLE = "Skrīb Server"
APP_VERSION = "1.0.0"

# WebAuthn settings
WEBAUTHN_RP_NAME = "Skrīb"
WEBAUTHN_RP_ID = os.getenv('SKRIB_RP_ID', 'localhost')

# Plugin Bus settings
PLUGIN_BUS_HOST = os.getenv('SKRIB_PLUGIN_BUS_HOST', '127.0.0.1')
PLUGIN_BUS_PORT = int(os.getenv('SKRIB_PLUGIN_BUS_PORT', '9000'))
