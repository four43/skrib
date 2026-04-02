"""Database utilities and connection management."""
import logging
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Optional

from .config import DB_FILE, DB_TIMEOUT

logger = logging.getLogger(__name__)

# Thread-local storage for database connections
thread_local = threading.local()

# Registry of all open connections (for test cleanup)
_all_connections: list[sqlite3.Connection] = []
_all_connections_lock = threading.Lock()


@contextmanager
def get_db():
    """Get a database connection with proper configuration."""
    if not hasattr(thread_local, 'connection') or thread_local.connection is None:
        thread_local.connection = sqlite3.connect(
            DB_FILE,
            timeout=DB_TIMEOUT,
            check_same_thread=False
        )
        thread_local.connection.row_factory = sqlite3.Row
        # Enable WAL mode for better concurrency
        thread_local.connection.execute('PRAGMA journal_mode=WAL')
        thread_local.connection.execute('PRAGMA foreign_keys=ON')
        with _all_connections_lock:
            _all_connections.append(thread_local.connection)

    try:
        yield thread_local.connection
    except Exception:
        thread_local.connection.rollback()
        raise


def close_all_connections():
    """Close all tracked database connections. Used by test fixtures."""
    with _all_connections_lock:
        for conn in _all_connections:
            try:
                conn.close()
            except Exception:
                pass
        _all_connections.clear()
    thread_local.connection = None


def init_db():
    """Initialize the database with required tables."""
    with get_db() as conn:
        # Users table (consolidated: users + pending + preferences + encryption keys)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                credential_id TEXT NOT NULL,
                public_key TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                role TEXT NOT NULL DEFAULT 'user',
                approval_code TEXT,
                encryption_public_key TEXT,
                color TEXT NOT NULL DEFAULT '#1976d2',
                nickname TEXT,
                created_at TEXT NOT NULL,
                approved_at TEXT,
                approved_by TEXT
            )
        ''')

        # Add theme_name column if it doesn't exist (migration)
        try:
            conn.execute('ALTER TABLE users ADD COLUMN theme_name TEXT')
        except Exception:
            pass

        # Add color_scheme column if it doesn't exist (migration)
        try:
            conn.execute('ALTER TABLE users ADD COLUMN color_scheme TEXT')
        except Exception:
            pass

        # Add encrypted_private_key column for PRF-wrapped E2E key backup
        try:
            conn.execute('ALTER TABLE users ADD COLUMN encrypted_private_key TEXT')
        except Exception:
            pass

        # Add passphrase_encrypted_private_key column for passphrase-wrapped E2E key backup
        try:
            conn.execute('ALTER TABLE users ADD COLUMN passphrase_encrypted_private_key TEXT')
        except Exception:
            pass

        # Add avatar_data column for generated identicon PNG
        try:
            conn.execute('ALTER TABLE users ADD COLUMN avatar_data BLOB')
        except Exception:
            pass

        # Add status_emoji and status_text columns for user status
        try:
            conn.execute('ALTER TABLE users ADD COLUMN status_emoji TEXT')
        except Exception:
            pass

        try:
            conn.execute('ALTER TABLE users ADD COLUMN status_text TEXT')
        except Exception:
            pass

        # Challenges table for WebAuthn
        conn.execute('''
            CREATE TABLE IF NOT EXISTS challenges (
                challenge TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                username TEXT,
                timestamp TEXT NOT NULL
            )
        ''')

        # Settings table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        ''')

        # Messages table is now managed by the chat plugin (four43.room-type-chat)

        # Rooms table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS rooms (
                room_id TEXT PRIMARY KEY,
                room_type TEXT NOT NULL DEFAULT 'chat',
                topic TEXT NOT NULL DEFAULT '',
                visibility TEXT NOT NULL DEFAULT 'private',
                created_at TEXT NOT NULL,
                created_by TEXT
            )
        ''')

        # Join requests table (users requesting to join public rooms)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS join_requests (
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                resolved_by TEXT,
                resolved_at TEXT,
                PRIMARY KEY (room_id, username),
                FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
                FOREIGN KEY (username) REFERENCES users(username)
            )
        ''')

        # Room users table (membership, read positions, roles)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS room_users (
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                room_role TEXT NOT NULL DEFAULT 'member',
                joined_at TEXT,
                last_read_message_id INTEGER NOT NULL DEFAULT 0,
                notify_level TEXT NOT NULL DEFAULT 'all',
                PRIMARY KEY (room_id, username),
                FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
                FOREIGN KEY (username) REFERENCES users(username)
            )
        ''')

        # Room keys table (E2E encryption keys separated from membership)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS room_keys (
                room_id TEXT NOT NULL,
                key_epoch INTEGER NOT NULL,
                username TEXT NOT NULL,
                encrypted_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (room_id, key_epoch, username),
                FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
                FOREIGN KEY (username) REFERENCES users(username)
            )
        ''')

        # Room folders table (nestable categories for channels)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS room_folders (
                folder_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_folder_id TEXT,
                position REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                created_by TEXT,
                FOREIGN KEY (parent_folder_id) REFERENCES room_folders(folder_id)
            )
        ''')

        # Add folder_id and sort_position to rooms table
        try:
            conn.execute('ALTER TABLE rooms ADD COLUMN folder_id TEXT REFERENCES room_folders(folder_id)')
        except Exception:
            pass

        try:
            conn.execute('ALTER TABLE rooms ADD COLUMN sort_position REAL NOT NULL DEFAULT 0')
        except Exception:
            pass

        # Invite tokens table for invite-only registration mode
        conn.execute('''
            CREATE TABLE IF NOT EXISTS invite_tokens (
                token TEXT PRIMARY KEY,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                used_by TEXT,
                used_at TEXT,
                FOREIGN KEY (created_by) REFERENCES users(username)
            )
        ''')

        # System log table for admin-visible events (backups, errors, etc.)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS system_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                level TEXT NOT NULL DEFAULT 'info',
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                details TEXT,
                username TEXT
            )
        ''')

        # Set default registration mode (env var override on first startup only)
        cursor = conn.execute("SELECT value FROM settings WHERE key = 'registration_mode'")
        if not cursor.fetchone():
            valid_modes = ('closed', 'invite_only', 'approval_required', 'open')
            env_mode = os.getenv('SKRIB_REGISTRATION_MODE')
            if env_mode and env_mode in valid_modes:
                default_reg_mode = env_mode
            else:
                if env_mode:
                    logger.warning(
                        "Invalid SKRIB_REGISTRATION_MODE '%s', falling back to 'approval_required'",
                        env_mode
                    )
                default_reg_mode = 'approval_required'
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('registration_mode', ?)",
                (default_reg_mode,)
            )

        # Set default theme (env var override on first startup only)
        cursor = conn.execute("SELECT value FROM settings WHERE key = 'default_theme'")
        if not cursor.fetchone():
            default_theme = os.getenv('SKRIB_DEFAULT_THEME', 'four43.theme-default')
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('default_theme', ?)",
                (default_theme,)
            )

        conn.commit()


def get_setting(key: str, default: str = None) -> Optional[str]:
    """Get a setting value."""
    with get_db() as conn:
        cursor = conn.execute('SELECT value FROM settings WHERE key = ?', (key,))
        row = cursor.fetchone()
        return row['value'] if row else default


def set_setting(key: str, value: str):
    """Set a setting value."""
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO settings (key, value)
            VALUES (?, ?)
        ''', (key, value))
        conn.commit()


def add_system_log(category: str, message: str, level: str = 'info',
                   details: str = None, username: str = None):
    """Add an entry to the system log."""
    with get_db() as conn:
        conn.execute(
            'INSERT INTO system_log (category, message, level, details, username) VALUES (?, ?, ?, ?, ?)',
            (category, message, level, details, username)
        )
        conn.commit()
