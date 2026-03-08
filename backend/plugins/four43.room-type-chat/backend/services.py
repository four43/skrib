"""Chat room message storage and retrieval, plus link preview caching.

Uses a plugin-scoped database provider instead of the core database.
The provider is set by the plugin during initialization.
"""
import html.parser
import logging
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.parse import urlparse

import requests as http_requests

log = logging.getLogger(__name__)


_get_db = None


def init_db_provider(get_db_fn):
    """Set the database provider. Called by the plugin during init."""
    global _get_db
    _get_db = get_db_fn


class ChatRoom:
    """Handles message persistence for a single room."""

    def __init__(self, room_id: str):
        self.room_id = room_id

    def add_message(
        self,
        username: str,
        content: str,
        content_type: str = 'text',
        key_epoch: Optional[int] = None
    ) -> Dict:
        """Add a message to the room."""
        timestamp = datetime.now(timezone.utc).isoformat()

        with _get_db() as conn:
            cursor = conn.execute('''
                INSERT INTO messages (room_id, username, content, content_type, key_epoch, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (self.room_id, username, content, content_type, key_epoch, timestamp))
            message_id = cursor.lastrowid
            conn.commit()

        return {
            'id': message_id,
            'username': username,
            'content': content,
            'content_type': content_type,
            'key_epoch': key_epoch,
            'timestamp': timestamp
        }

    def edit_message(
        self,
        message_id: int,
        username: str,
        content: str,
        content_type: str = 'text',
        key_epoch: Optional[int] = None,
    ) -> Dict:
        """Edit a message. Only the author can edit."""
        with _get_db() as conn:
            cursor = conn.execute(
                'SELECT id, username FROM messages WHERE id = ? AND room_id = ?',
                (message_id, self.room_id),
            )
            row = cursor.fetchone()
            if not row:
                raise ValueError("Message not found")
            if row['username'] != username:
                raise PermissionError("Can only edit your own messages")

            edited_at = datetime.now(timezone.utc).isoformat()
            conn.execute('''
                UPDATE messages
                SET content = ?, content_type = ?, key_epoch = ?, edited_at = ?
                WHERE id = ?
            ''', (content, content_type, key_epoch, edited_at, message_id))
            conn.commit()

        return {
            'message_id': message_id,
            'content': content,
            'content_type': content_type,
            'key_epoch': key_epoch,
            'edited_at': edited_at,
        }

    def delete_message(
        self,
        message_id: int,
        username: str,
        is_admin: bool = False,
    ) -> Dict:
        """Soft-delete a message. Author or admin can delete."""
        with _get_db() as conn:
            cursor = conn.execute(
                'SELECT id, username FROM messages WHERE id = ? AND room_id = ?',
                (message_id, self.room_id),
            )
            row = cursor.fetchone()
            if not row:
                raise ValueError("Message not found")
            if row['username'] != username and not is_admin:
                raise PermissionError("Can only delete your own messages")

            conn.execute(
                'UPDATE messages SET deleted = 1 WHERE id = ?',
                (message_id,),
            )
            conn.commit()

        return {'message_id': message_id, 'deleted': True}

    def get_messages(
        self,
        since: int = 0,
        before: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[Dict]:
        """Get messages with cursor-based pagination.

        Args:
            since: Return messages with id > since (exclusive lower bound).
            before: Return messages with id < before (exclusive upper bound).
            limit: Max number of messages to return. When used with ``before``
                   (or alone), the *most recent* ``limit`` messages in the
                   range are returned in ascending id order.
        """
        with _get_db() as conn:
            conditions = ["room_id = ?"]
            params: list = [self.room_id]

            if since:
                conditions.append("id > ?")
                params.append(since)
            if before is not None:
                conditions.append("id < ?")
                params.append(before)

            where = " AND ".join(conditions)

            if limit is not None and not since:
                # Loading recent / older messages: grab the last N rows by
                # sorting DESC, then reverse so the caller gets ASC order.
                query = f"""
                    SELECT id, username, content, content_type, key_epoch,
                           timestamp, edited_at, deleted
                    FROM messages
                    WHERE {where}
                    ORDER BY id DESC
                    LIMIT ?
                """
                params.append(limit)
                cursor = conn.execute(query, params)
                rows = list(cursor)
                rows.reverse()
            else:
                query = f"""
                    SELECT id, username, content, content_type, key_epoch,
                           timestamp, edited_at, deleted
                    FROM messages
                    WHERE {where}
                    ORDER BY id
                """
                if limit is not None:
                    query += " LIMIT ?"
                    params.append(limit)
                cursor = conn.execute(query, params)
                rows = list(cursor)

            messages = []
            for row in rows:
                msg = {
                    'id': row['id'],
                    'username': row['username'],
                    'content': '' if row['deleted'] else row['content'],
                    'content_type': row['content_type'],
                    'key_epoch': row['key_epoch'],
                    'timestamp': row['timestamp'],
                    'edited_at': row['edited_at'],
                    'deleted': bool(row['deleted']),
                }
                messages.append(msg)

            return messages


# ---------------------------------------------------------------------------
# Link preview fetching and caching
# ---------------------------------------------------------------------------

# File extensions that indicate an image (rendered inline on the frontend).
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'}

# Max bytes we'll download when fetching a page for OG tags.
_MAX_FETCH_BYTES = 128 * 1024  # 128 KB
_FETCH_TIMEOUT = 5  # seconds


class _OGParser(html.parser.HTMLParser):
    """Minimal HTML parser that extracts Open Graph and basic <title> tags."""

    def __init__(self):
        super().__init__()
        self.og: Dict[str, str] = {}
        self.title = ''
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self._in_title = True
            return
        if tag == 'meta':
            d = dict(attrs)
            prop = d.get('property', '') or d.get('name', '')
            content = d.get('content', '')
            if prop.startswith('og:') and content:
                self.og[prop[3:]] = content

    def handle_data(self, data):
        if self._in_title:
            self.title += data

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False


class LinkPreviewService:
    """Fetch, parse, and cache link previews."""

    def __init__(self, get_db):
        self._get_db = get_db

    # -- cache layer --------------------------------------------------------

    def get_cached(self, url: str) -> Optional[Dict]:
        with self._get_db() as conn:
            row = conn.execute(
                'SELECT url, title, description, image, site_name, content_type FROM link_previews WHERE url = ?',
                (url,),
            ).fetchone()
            if row:
                return dict(row)
        return None

    def _store(self, data: Dict):
        with self._get_db() as conn:
            conn.execute('''
                INSERT OR REPLACE INTO link_previews (url, title, description, image, site_name, content_type, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (
                data['url'],
                data.get('title', ''),
                data.get('description', ''),
                data.get('image', ''),
                data.get('site_name', ''),
                data.get('content_type', 'webpage'),
                datetime.now(timezone.utc).isoformat(),
            ))
            conn.commit()

    # -- public API ---------------------------------------------------------

    def fetch_preview(self, url: str) -> Dict:
        """Return a preview dict for *url*. Uses cache if available."""
        cached = self.get_cached(url)
        if cached:
            return cached

        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return {'url': url, 'content_type': 'unknown'}

        # Quick check: is this a direct image link?
        ext = _path_extension(parsed.path)
        if ext in IMAGE_EXTENSIONS:
            data = {'url': url, 'content_type': 'image', 'title': '', 'description': '', 'image': url, 'site_name': ''}
            self._store(data)
            return data

        # Fetch the page and parse OG tags
        try:
            resp = http_requests.get(
                url,
                timeout=_FETCH_TIMEOUT,
                headers={'User-Agent': 'Skrib-LinkPreview/1.0'},
                stream=True,
            )
            resp.raise_for_status()

            ct = resp.headers.get('content-type', '')
            if ct.startswith('image/'):
                data = {'url': url, 'content_type': 'image', 'title': '', 'description': '', 'image': url, 'site_name': ''}
                self._store(data)
                return data

            # Only parse HTML
            if 'html' not in ct:
                data = {'url': url, 'content_type': 'unknown', 'title': '', 'description': '', 'image': '', 'site_name': ''}
                self._store(data)
                return data

            body = resp.content[:_MAX_FETCH_BYTES].decode('utf-8', errors='replace')
            parser = _OGParser()
            parser.feed(body)

            title = parser.og.get('title', '') or parser.title.strip()
            description = parser.og.get('description', '')
            image = parser.og.get('image', '')
            site_name = parser.og.get('site_name', '')

            data = {
                'url': url,
                'content_type': 'webpage',
                'title': title,
                'description': description,
                'image': image,
                'site_name': site_name,
            }
            self._store(data)
            return data

        except Exception as exc:
            log.debug('[LinkPreview] Failed to fetch %s: %s', url, exc)
            data = {'url': url, 'content_type': 'error', 'title': '', 'description': '', 'image': '', 'site_name': ''}
            self._store(data)
            return data


def _path_extension(path: str) -> str:
    """Return the lowercased file extension (e.g. '.png') from a URL path."""
    dot = path.rfind('.')
    if dot == -1:
        return ''
    return path[dot:].lower().split('?')[0].split('#')[0]
