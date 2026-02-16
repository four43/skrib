"""Configuration settings for the application."""
import os
from pathlib import Path

# Project root (backend directory)
BACKEND_ROOT = Path(__file__).parent.parent

# Database configuration
DB_DIR = Path(os.getenv('MINICHAT_DATA_DIR', str(BACKEND_ROOT.parent / "data")))
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
APP_TITLE = "Mini-Chat Server"
APP_VERSION = "1.0.0"
