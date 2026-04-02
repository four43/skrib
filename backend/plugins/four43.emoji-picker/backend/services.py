"""Custom emoji storage — metadata in plugin-scoped SQLite, images on disk."""
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from skrib.config import DB_DIR

_get_db = None

PLUGIN_ID = "four43.emoji-picker"
FILES_DIR = DB_DIR / "plugins" / PLUGIN_ID / "files"

SHORTCODE_RE = re.compile(r'^[a-z0-9-]+$')
ALLOWED_CONTENT_TYPES = {"image/png", "image/gif"}
MAX_FILE_SIZE = 256 * 1024  # 256KB


def init_db_provider(get_db_fn):
    """Set the database provider. Called by the plugin during init."""
    global _get_db
    _get_db = get_db_fn


def ensure_files_dir():
    """Create the files directory if it doesn't exist."""
    FILES_DIR.mkdir(parents=True, exist_ok=True)


def validate_shortcode(shortcode: str) -> str | None:
    """Validate shortcode format. Returns error message or None."""
    if not shortcode:
        return "Shortcode is required"
    if len(shortcode) > 64:
        return "Shortcode must be 64 characters or fewer"
    if not SHORTCODE_RE.match(shortcode):
        return "Shortcode must contain only lowercase letters, numbers, and hyphens"
    return None


def list_custom_emoji() -> list[dict]:
    """List all custom emoji."""
    with _get_db() as conn:
        cursor = conn.execute(
            'SELECT shortcode, display_name, category FROM custom_emoji ORDER BY shortcode'
        )
        return [
            {
                "shortcode": row["shortcode"],
                "display_name": row["display_name"],
                "category": row["category"],
                "url": f"/api/plugins/{PLUGIN_ID}/custom-emoji/{row['shortcode']}",
            }
            for row in cursor.fetchall()
        ]


def get_custom_emoji(shortcode: str) -> dict | None:
    """Get a single custom emoji's metadata."""
    with _get_db() as conn:
        cursor = conn.execute(
            'SELECT * FROM custom_emoji WHERE shortcode = ?', (shortcode,)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def get_emoji_file_path(shortcode: str) -> Path | None:
    """Get the file path for a custom emoji image. Returns None if not found."""
    meta = get_custom_emoji(shortcode)
    if not meta:
        return None
    path = FILES_DIR / meta["filename"]
    if not path.exists():
        return None
    return path


def create_custom_emoji(
    shortcode: str,
    display_name: str,
    file_data: bytes,
    content_type: str,
    category: str,
    uploaded_by: str,
) -> dict:
    """Create a new custom emoji. Returns the created emoji metadata.

    Raises:
        ValueError: If validation fails or shortcode already exists.
    """
    err = validate_shortcode(shortcode)
    if err:
        raise ValueError(err)

    if content_type not in ALLOWED_CONTENT_TYPES:
        raise ValueError(f"File must be PNG or GIF, got {content_type}")

    if len(file_data) > MAX_FILE_SIZE:
        raise ValueError(f"File must be under 256KB, got {len(file_data)} bytes")

    if not display_name or not display_name.strip():
        raise ValueError("Display name is required")

    ext = "png" if content_type == "image/png" else "gif"
    filename = f"{uuid.uuid4().hex}.{ext}"
    created_at = datetime.now(timezone.utc).isoformat()

    ensure_files_dir()

    # Check for duplicate shortcode
    existing = get_custom_emoji(shortcode)
    if existing:
        raise ValueError(f"Shortcode '{shortcode}' already exists")

    # Write file to disk
    file_path = FILES_DIR / filename
    file_path.write_bytes(file_data)

    try:
        with _get_db() as conn:
            conn.execute(
                '''INSERT INTO custom_emoji
                   (shortcode, display_name, filename, content_type, file_size, category, uploaded_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (shortcode, display_name.strip(), filename, content_type, len(file_data), category, uploaded_by, created_at),
            )
            conn.commit()
    except Exception:
        # Clean up file on DB error
        file_path.unlink(missing_ok=True)
        raise

    return {
        "shortcode": shortcode,
        "display_name": display_name.strip(),
        "category": category,
        "url": f"/api/plugins/{PLUGIN_ID}/custom-emoji/{shortcode}",
    }


def update_custom_emoji(shortcode: str, display_name: str | None = None, category: str | None = None) -> dict | None:
    """Update custom emoji metadata. Returns updated emoji or None if not found."""
    existing = get_custom_emoji(shortcode)
    if not existing:
        return None

    new_name = display_name.strip() if display_name else existing["display_name"]
    new_category = category if category else existing["category"]

    with _get_db() as conn:
        conn.execute(
            'UPDATE custom_emoji SET display_name = ?, category = ? WHERE shortcode = ?',
            (new_name, new_category, shortcode),
        )
        conn.commit()

    return {
        "shortcode": shortcode,
        "display_name": new_name,
        "category": new_category,
        "url": f"/api/plugins/{PLUGIN_ID}/custom-emoji/{shortcode}",
    }


def delete_custom_emoji(shortcode: str) -> bool:
    """Delete a custom emoji. Returns True if deleted, False if not found."""
    existing = get_custom_emoji(shortcode)
    if not existing:
        return False

    # Delete file from disk
    file_path = FILES_DIR / existing["filename"]
    file_path.unlink(missing_ok=True)

    # Delete from DB
    with _get_db() as conn:
        conn.execute('DELETE FROM custom_emoji WHERE shortcode = ?', (shortcode,))
        conn.commit()

    return True
