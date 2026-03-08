"""Attachment storage — file chunks on disk, metadata in plugin-scoped SQLite."""
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from skrib.config import DB_DIR

_get_db = None

FILES_DIR = DB_DIR / "plugins" / "four43.attachments" / "files"


def init_db_provider(get_db_fn):
    """Set the database provider. Called by the plugin during init."""
    global _get_db
    _get_db = get_db_fn


def ensure_files_dir():
    """Create the files directory if it doesn't exist."""
    FILES_DIR.mkdir(parents=True, exist_ok=True)


def _attachment_dir(attachment_id: str) -> Path:
    return FILES_DIR / attachment_id


def _chunk_path(attachment_id: str, chunk_index: int) -> Path:
    return _attachment_dir(attachment_id) / f"chunk_{chunk_index}"


class AttachmentStore:
    """Manages attachment metadata (DB) and encrypted chunk files (disk)."""

    def create_attachment(self, room_id: str, username: str, key_epoch: int) -> str:
        attachment_id = uuid.uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()

        with _get_db() as conn:
            conn.execute(
                '''INSERT INTO attachments (id, room_id, username, chunk_count, total_size, key_epoch, status, created_at)
                   VALUES (?, ?, ?, 0, 0, ?, 'pending', ?)''',
                (attachment_id, room_id, username, key_epoch, created_at),
            )
            conn.commit()

        # Create directory for chunks
        _attachment_dir(attachment_id).mkdir(parents=True, exist_ok=True)
        return attachment_id

    def get_attachment(self, attachment_id: str) -> dict | None:
        with _get_db() as conn:
            row = conn.execute(
                'SELECT * FROM attachments WHERE id = ?', (attachment_id,)
            ).fetchone()
            return dict(row) if row else None

    def store_chunk(self, attachment_id: str, chunk_index: int, data: bytes, iv: str) -> int:
        chunk_file = _chunk_path(attachment_id, chunk_index)
        chunk_file.write_bytes(data)
        chunk_size = len(data)

        with _get_db() as conn:
            conn.execute(
                '''INSERT OR REPLACE INTO attachment_chunks (attachment_id, chunk_index, size, iv)
                   VALUES (?, ?, ?, ?)''',
                (attachment_id, chunk_index, chunk_size, iv),
            )
            conn.commit()

        return chunk_size

    def finalize(self, attachment_id: str, expected_chunks: int) -> dict:
        with _get_db() as conn:
            rows = conn.execute(
                'SELECT chunk_index, size FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index',
                (attachment_id,),
            ).fetchall()

            if len(rows) != expected_chunks:
                raise ValueError(f"Expected {expected_chunks} chunks, got {len(rows)}")

            total_size = sum(r['size'] for r in rows)

            conn.execute(
                '''UPDATE attachments SET status = 'complete', chunk_count = ?, total_size = ?
                   WHERE id = ?''',
                (expected_chunks, total_size, attachment_id),
            )
            conn.commit()

        return {
            'attachment_id': attachment_id,
            'chunk_count': expected_chunks,
            'total_size': total_size,
        }

    def get_meta(self, attachment_id: str) -> dict | None:
        with _get_db() as conn:
            att = conn.execute(
                'SELECT * FROM attachments WHERE id = ?', (attachment_id,)
            ).fetchone()
            if not att:
                return None

            chunks = conn.execute(
                'SELECT chunk_index, size, iv FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index',
                (attachment_id,),
            ).fetchall()

        return {
            'attachment_id': att['id'],
            'room_id': att['room_id'],
            'username': att['username'],
            'chunk_count': att['chunk_count'],
            'total_size': att['total_size'],
            'key_epoch': att['key_epoch'],
            'status': att['status'],
            'chunks': [{'chunk_index': c['chunk_index'], 'size': c['size'], 'iv': c['iv']} for c in chunks],
        }

    def get_chunk_data(self, attachment_id: str, chunk_index: int) -> bytes | None:
        chunk_file = _chunk_path(attachment_id, chunk_index)
        if not chunk_file.exists():
            return None
        return chunk_file.read_bytes()

    def delete_attachment(self, attachment_id: str):
        # Remove files
        att_dir = _attachment_dir(attachment_id)
        if att_dir.exists():
            shutil.rmtree(att_dir)

        # Remove DB rows
        with _get_db() as conn:
            conn.execute('DELETE FROM attachment_chunks WHERE attachment_id = ?', (attachment_id,))
            conn.execute('DELETE FROM attachments WHERE id = ?', (attachment_id,))
            conn.commit()

    def delete_room_attachments(self, room_id: str):
        with _get_db() as conn:
            rows = conn.execute(
                'SELECT id FROM attachments WHERE room_id = ?', (room_id,)
            ).fetchall()

        for row in rows:
            self.delete_attachment(row['id'])

    def cleanup_stale(self, max_age_hours: int = 1):
        """Delete pending attachments older than max_age_hours."""
        cutoff = datetime.now(timezone.utc)
        with _get_db() as conn:
            rows = conn.execute(
                "SELECT id, created_at FROM attachments WHERE status = 'pending'"
            ).fetchall()

        for row in rows:
            try:
                created = datetime.fromisoformat(row['created_at'])
                age_hours = (cutoff - created).total_seconds() / 3600
                if age_hours > max_age_hours:
                    self.delete_attachment(row['id'])
            except (ValueError, TypeError):
                self.delete_attachment(row['id'])
