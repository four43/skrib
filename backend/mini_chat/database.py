"""Database utilities and connection management."""
import sqlite3
import threading
from contextlib import contextmanager
from typing import Optional

from .config import DB_FILE, DB_TIMEOUT

# Thread-local storage for database connections
thread_local = threading.local()


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

    try:
        yield thread_local.connection
    except Exception:
        thread_local.connection.rollback()
        raise


def init_db():
    """Initialize the database with required tables."""
    with get_db() as conn:
        # Users table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                credential_id TEXT NOT NULL,
                public_key TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                approved BOOLEAN NOT NULL DEFAULT 1,
                approved_at TEXT,
                approved_by TEXT
            )
        ''')

        # Pending users table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS pending_users (
                username TEXT PRIMARY KEY,
                credential_id TEXT NOT NULL,
                public_key TEXT NOT NULL,
                approval_code TEXT NOT NULL UNIQUE,
                registered_at TEXT NOT NULL,
                approved BOOLEAN NOT NULL DEFAULT 0
            )
        ''')

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

        # Messages table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        ''')

        # Create index for faster message queries
        conn.execute('''
            CREATE INDEX IF NOT EXISTS idx_messages_room_id
            ON messages(room_id, id)
        ''')

        # Rooms table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS rooms (
                room_id TEXT PRIMARY KEY,
                room_type TEXT NOT NULL DEFAULT 'channel',
                created_at TEXT NOT NULL,
                deleted BOOLEAN NOT NULL DEFAULT 0,
                deleted_at TEXT,
                deleted_by TEXT
            )
        ''')

        # Room members table (membership, read positions, and encrypted room keys)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS room_members (
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                last_read_message_id INTEGER NOT NULL DEFAULT 0,
                encrypted_keys TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (room_id, username),
                FOREIGN KEY (room_id) REFERENCES rooms(room_id),
                FOREIGN KEY (username) REFERENCES users(username)
            )
        ''')

        # User encryption keys (for E2E encryption)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS user_encryption_keys (
                username TEXT PRIMARY KEY,
                public_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (username) REFERENCES users(username)
            )
        ''')

        # User preferences table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS user_preferences (
                username TEXT PRIMARY KEY,
                color TEXT NOT NULL DEFAULT '#1976d2',
                theme_color TEXT,
                nickname TEXT,
                FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
            )
        ''')

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

        # Set default registration mode
        cursor = conn.execute("SELECT value FROM settings WHERE key = 'registration_mode'")
        if not cursor.fetchone():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('registration_mode', 'approval_required')"
            )

        # Set default server color
        cursor = conn.execute("SELECT value FROM settings WHERE key = 'server_color'")
        if not cursor.fetchone():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('server_color', '#6366f1')"
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
