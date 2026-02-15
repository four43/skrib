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
                theme_color TEXT,
                created_at TEXT NOT NULL,
                approved_at TEXT,
                approved_by TEXT
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
                content TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT 'text',
                key_epoch INTEGER,
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
                topic TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                created_by TEXT,
                deleted BOOLEAN NOT NULL DEFAULT 0,
                deleted_at TEXT,
                deleted_by TEXT
            )
        ''')

        # Room users table (membership, read positions, roles, and encrypted room keys)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS room_users (
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                room_role TEXT NOT NULL DEFAULT 'member',
                joined_at TEXT,
                last_read_message_id INTEGER NOT NULL DEFAULT 0,
                encrypted_keys TEXT NOT NULL DEFAULT '{}',
                notify_level TEXT NOT NULL DEFAULT 'all',
                PRIMARY KEY (room_id, username),
                FOREIGN KEY (room_id) REFERENCES rooms(room_id),
                FOREIGN KEY (username) REFERENCES users(username)
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
