"""Plugin approval service — manages admin approval state for out-of-process plugins.

Plugins must be approved by an admin before they can activate. When a plugin
connects, its manifest is hashed and compared against the stored approval.
If the manifest has changed, the plugin re-enters pending state.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from ..database import get_db

logger = logging.getLogger(__name__)


def _manifest_hash(manifest: dict) -> str:
    """Compute a stable SHA-256 hash of a manifest dict."""
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Query operations
# ---------------------------------------------------------------------------

def get_approval(plugin_id: str) -> Optional[dict]:
    """Get the current approval record for a plugin."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        return dict(row) if row else None


def list_by_status(status: str) -> list[dict]:
    """List all plugin approvals with a given status."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM plugin_approvals WHERE status = ? ORDER BY updated_at DESC",
            (status,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_all() -> list[dict]:
    """List all plugin approval records."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM plugin_approvals ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Approval check (called during plugin hello handshake)
# ---------------------------------------------------------------------------

def check_plugin_approval(plugin_id: str, manifest: dict) -> str:
    """Check whether a plugin is approved to connect.

    Returns one of: 'approved', 'pending', 'rejected', 'disabled'.

    Side effects:
    - If the plugin is new, creates a 'pending' record.
    - If the manifest hash changed on an approved plugin, re-enters 'pending'.
    """
    m_hash = _manifest_hash(manifest)
    now = _now()

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()

        if row is None:
            # New plugin — create pending record
            conn.execute(
                """INSERT INTO plugin_approvals
                   (plugin_id, status, manifest_hash, manifest_json, created_at, updated_at)
                   VALUES (?, 'pending', ?, ?, ?, ?)""",
                (plugin_id, m_hash, json.dumps(manifest, sort_keys=True), now, now),
            )
            conn.commit()
            logger.info("[Approvals] New plugin '%s' — pending approval", plugin_id)
            return "pending"

        record = dict(row)
        status = record["status"]

        if status == "approved":
            if record["manifest_hash"] == m_hash:
                return "approved"
            else:
                # Manifest changed — re-enter pending
                conn.execute(
                    """UPDATE plugin_approvals
                       SET status = 'pending', manifest_hash = ?, manifest_json = ?, updated_at = ?
                       WHERE plugin_id = ?""",
                    (m_hash, json.dumps(manifest, sort_keys=True), now, plugin_id),
                )
                conn.commit()
                logger.info("[Approvals] Plugin '%s' manifest changed — re-pending", plugin_id)
                return "pending"

        if status in ("rejected", "disabled"):
            return status

        # Already pending — update manifest in case it changed
        if record["manifest_hash"] != m_hash:
            conn.execute(
                """UPDATE plugin_approvals
                   SET manifest_hash = ?, manifest_json = ?, updated_at = ?
                   WHERE plugin_id = ?""",
                (m_hash, json.dumps(manifest, sort_keys=True), now, plugin_id),
            )
            conn.commit()

        return "pending"


# ---------------------------------------------------------------------------
# Admin actions
# ---------------------------------------------------------------------------

def approve_plugin(plugin_id: str, admin_username: str) -> bool:
    """Approve a pending plugin. Returns True if the status changed."""
    now = _now()
    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not row:
            return False

        conn.execute(
            """UPDATE plugin_approvals
               SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
               WHERE plugin_id = ?""",
            (admin_username, now, now, plugin_id),
        )
        conn.commit()
        logger.info("[Approvals] Plugin '%s' approved by %s", plugin_id, admin_username)
        return True


def reject_plugin(plugin_id: str) -> bool:
    """Reject a plugin. Returns True if the status changed."""
    now = _now()
    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not row:
            return False

        conn.execute(
            "UPDATE plugin_approvals SET status = 'rejected', updated_at = ? WHERE plugin_id = ?",
            (now, plugin_id),
        )
        conn.commit()
        logger.info("[Approvals] Plugin '%s' rejected", plugin_id)
        return True


def disable_plugin(plugin_id: str) -> bool:
    """Disable an approved plugin. Returns True if the status changed."""
    now = _now()
    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not row:
            return False

        conn.execute(
            "UPDATE plugin_approvals SET status = 'disabled', updated_at = ? WHERE plugin_id = ?",
            (now, plugin_id),
        )
        conn.commit()
        logger.info("[Approvals] Plugin '%s' disabled", plugin_id)
        return True


def get_manifest_diff(plugin_id: str) -> Optional[dict]:
    """Get the stored manifest for diff comparison.

    Returns the current manifest_json and previous approval info,
    or None if the plugin doesn't exist.
    """
    record = get_approval(plugin_id)
    if not record:
        return None

    return {
        "plugin_id": plugin_id,
        "status": record["status"],
        "manifest": json.loads(record["manifest_json"]),
        "manifest_hash": record["manifest_hash"],
        "approved_by": record.get("approved_by"),
        "approved_at": record.get("approved_at"),
        "updated_at": record["updated_at"],
    }
