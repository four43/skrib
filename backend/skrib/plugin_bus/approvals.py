"""Plugin approval service — manages admin approval state for out-of-process plugins.

Plugins must be approved by an admin before they can activate. When a plugin
connects, its manifest is hashed and compared against the stored approval.
If the manifest has changed, the plugin re-enters pending state.
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

from ..database import get_db

logger = logging.getLogger(__name__)


def _manifest_hash(manifest: dict) -> str:
    """Compute a stable SHA-256 hash of the security-relevant manifest fields.

    Only fields that affect what a plugin can do are included. Cosmetic fields
    (name, description, author, entry, styles, hooks) are excluded so that
    updating them doesn't force re-approval.
    """
    security_fields = {
        "id": manifest.get("id"),
        "version": manifest.get("version"),
        "permissions": manifest.get("permissions", []),
        "published_events": manifest.get("published_events", []),
        "subscriptions": manifest.get("subscriptions", []),
        "room_types": manifest.get("room_types", []),
    }
    canonical = json.dumps(security_fields, sort_keys=True, separators=(",", ":"))
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


def sync_secret_files() -> None:
    """Write secret files for all approved plugins that have secrets.

    Called on startup to ensure the secret files exist for plugins
    that were approved before the file-based secret mechanism was added.
    """
    for record in list_by_status("approved"):
        secret = record.get("secret")
        if secret:
            _write_plugin_secret(record["plugin_id"], secret)


# ---------------------------------------------------------------------------
# Admin actions
# ---------------------------------------------------------------------------

def get_plugin_secret(plugin_id: str) -> Optional[str]:
    """Get the stored secret for a plugin, or None if not yet approved."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT secret FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        return row["secret"] if row and row["secret"] else None


def approve_plugin(plugin_id: str, admin_username: str) -> bool:
    """Approve a pending plugin. Generates a secret if one doesn't exist.

    Returns True if the status changed."""
    now = _now()
    with get_db() as conn:
        row = conn.execute(
            "SELECT status, secret FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not row:
            return False

        # Generate a secret on first approval; preserve it on re-approval
        plugin_secret = row["secret"] if row["secret"] else secrets.token_hex(32)

        conn.execute(
            """UPDATE plugin_approvals
               SET status = 'approved', secret = ?, approved_by = ?, approved_at = ?, updated_at = ?
               WHERE plugin_id = ?""",
            (plugin_secret, admin_username, now, now, plugin_id),
        )
        conn.commit()
        logger.info("[Approvals] Plugin '%s' approved by %s", plugin_id, admin_username)

        # Write secret to file so the plugin process can read it on startup
        _write_plugin_secret(plugin_id, plugin_secret)

        return True


def _write_plugin_secret(plugin_id: str, secret: str) -> None:
    """Write a plugin's secret to data/plugin-secrets/{plugin_id}.secret."""
    from ..config import DB_DIR
    secrets_dir = DB_DIR / "plugin-secrets"
    secrets_dir.mkdir(parents=True, exist_ok=True)
    secret_file = secrets_dir / f"{plugin_id}.secret"
    secret_file.write_text(secret)
    # Restrict permissions (owner-only read/write)
    secret_file.chmod(0o600)
    logger.info("[Approvals] Wrote secret for '%s' to %s", plugin_id, secret_file)


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


def delete_approval(plugin_id: str) -> bool:
    """Delete a plugin's approval record entirely.

    Used to clear stale ``pending`` entries left behind by plugins that
    connected once and never returned. Returns True if a row was deleted.
    """
    with get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM plugin_approvals WHERE plugin_id = ?", (plugin_id,)
        )
        conn.commit()
        if cursor.rowcount:
            logger.info("[Approvals] Plugin '%s' approval record deleted", plugin_id)
        return cursor.rowcount > 0


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
