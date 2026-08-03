"""One runtime-agnostic view of active plugins.

Before this existed, four separate call sites answered "is this plugin active,
and what are its details?" by reaching into the bus server's connection map.
That map only describes plugins running as separate processes, so each call site
silently excluded in-process plugins. They all consult this instead.

Adding a third runtime means changing this file, not four others.
"""
from __future__ import annotations

import logging
from typing import Any

from ..plugin_bus.protocol import ApprovalStatus

logger = logging.getLogger(__name__)

RECORD_KEYS = (
    "id", "version", "permissions", "room_types", "room_type_meta",
    "frontend_scripts", "frontend_styles", "http_base_url", "runtime",
)


class PluginRegistry:
    """Presents bus-connected and in-process plugins through one interface."""

    def __init__(self, bus_server: Any, inprocess_host: Any | None = None):
        self._bus = bus_server
        self._host = inprocess_host

    def _record_from_conn(self, conn: Any) -> dict | None:
        """Build a record from a bus ``PluginConnection``, or ``None`` if it
        is not approved.

        Only a *rejected* connection is ever evicted from the bus server's
        connection map (see ``PluginBusServer._handle_hello``) — a pending
        one stays there awaiting admin approval. Bus presence alone is
        therefore not "active"; every caller needs this same approval check,
        so it lives here rather than in each of them.
        """
        status = getattr(conn, "status", ApprovalStatus.APPROVED)
        if status != ApprovalStatus.APPROVED:
            return None
        return {
            "id": conn.plugin_id,
            "version": getattr(conn, "version", ""),
            "permissions": list(getattr(conn, "permissions", ()) or ()),
            "room_types": list(getattr(conn, "room_types", ()) or ()),
            "room_type_meta": dict(getattr(conn, "room_type_meta", {}) or {}),
            "frontend_scripts": list(getattr(conn, "frontend_scripts", ()) or ()),
            "frontend_styles": list(getattr(conn, "frontend_styles", ()) or ()),
            "http_base_url": getattr(conn, "http_base_url", None),
            "runtime": "process",
        }

    def get(self, plugin_id: str) -> dict | None:
        """Return the active plugin's record, or None if it is not running.

        In-process is checked first, so an id present in both sources (e.g.
        mid-migration to a new runtime) resolves to the in-process record.
        """
        if self._host is not None:
            for rec in self._host.plugin_records():
                if rec["id"] == plugin_id:
                    return rec
        if self._bus is not None:
            conn = self._bus.get_plugin(plugin_id)
            if conn is not None:
                return self._record_from_conn(conn)
        return None

    def all(self) -> list[dict]:
        """Every active plugin, in-process first. Ids are unique."""
        records: list[dict] = []
        seen: set[str] = set()
        if self._host is not None:
            for rec in self._host.plugin_records():
                records.append(rec)
                seen.add(rec["id"])
        if self._bus is not None:
            # PluginBusServer.plugins is its one public, read-only view of
            # connected plugins (a property returning a shallow copy of its
            # connection map) — the same one routes.py's plugin listing
            # already relied on before this registry existed.
            for plugin_id, conn in self._bus.plugins.items():
                if plugin_id in seen:
                    continue
                rec = self._record_from_conn(conn)
                if rec is not None:
                    records.append(rec)
                    seen.add(plugin_id)
        return records

    def is_active(self, plugin_id: str) -> bool:
        return self.get(plugin_id) is not None
