"""Plugin Bus protocol — frame types, validation, and serialization.

All communication between the bus server and plugin processes uses JSON frames
over WebSocket. Each frame has a ``type`` field and type-specific payload fields.
Frames that expect a response include a ``request_id`` for correlation.

Outgoing plugin messages are auto-namespaced by the bus server — plugins cannot
spoof another plugin's namespace.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


def make_request_id() -> str:
    return uuid.uuid4().hex[:12]


# ---------------------------------------------------------------------------
# Frame type enum
# ---------------------------------------------------------------------------

class FrameType(str, Enum):
    """All recognised frame types on the plugin bus."""

    # Connection lifecycle
    HELLO = "hello"
    HELLO_ACK = "hello_ack"
    GOODBYE = "goodbye"

    # Plugin → Core: bus operations
    BUS_BROADCAST_ROOM = "bus.broadcast_room"
    BUS_NOTIFY_USER = "bus.notify_user"
    BUS_NOTIFY_ALL = "bus.notify_all"
    BUS_REPLY = "bus.reply"
    BUS_EMIT_EVENT = "bus.emit_event"

    # Plugin → Core: registration
    REGISTER_ROOM_TYPE = "register.room_type"
    REGISTER_FRONTEND = "register.frontend"
    REGISTER_SETTINGS = "register.settings"
    REGISTER_CALLBACK = "register.callback"

    # Plugin → Core: core API queries
    CORE_API_REQUEST = "core_api.request"
    CORE_API_RESPONSE = "core_api.response"

    # Core → Plugin: dispatched work
    ROOM_ACTION = "room.action"
    LIFECYCLE_ROOM_CREATED = "lifecycle.room_created"
    LIFECYCLE_ROOM_DELETED = "lifecycle.room_deleted"
    LIFECYCLE_USER_JOINED = "lifecycle.user_joined"
    LIFECYCLE_USER_LEFT = "lifecycle.user_left"

    # Core → Plugin: callbacks (request/response)
    CALLBACK_REQUEST = "callback.request"
    CALLBACK_RESPONSE = "callback.response"

    # Bidirectional
    EVENT = "event"
    CONFIG_UPDATED = "config.updated"
    ERROR = "error"


# ---------------------------------------------------------------------------
# Approval status for hello_ack
# ---------------------------------------------------------------------------

class ApprovalStatus(str, Enum):
    APPROVED = "approved"
    PENDING = "pending_approval"
    REJECTED = "rejected"


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

VALID_PERMISSIONS = frozenset({
    "bus.send",
    "bus.receive",
    "room_type.register",
    "http.routes",
    "storage.read",
    "storage.write",
    "core_api",
    "frontend.register",
    "settings.register",
    "callbacks.register",
})

# Map frame types to the permission required to send them
FRAME_PERMISSION_MAP: dict[FrameType, str] = {
    FrameType.BUS_BROADCAST_ROOM: "bus.send",
    FrameType.BUS_NOTIFY_USER: "bus.send",
    FrameType.BUS_NOTIFY_ALL: "bus.send",
    FrameType.BUS_REPLY: "bus.send",
    FrameType.BUS_EMIT_EVENT: "bus.send",
    FrameType.REGISTER_ROOM_TYPE: "room_type.register",
    FrameType.REGISTER_FRONTEND: "frontend.register",
    FrameType.REGISTER_SETTINGS: "settings.register",
    FrameType.REGISTER_CALLBACK: "callbacks.register",
    FrameType.CORE_API_REQUEST: "core_api",
}


# ---------------------------------------------------------------------------
# Required fields per frame type (top-level keys beyond "type")
# ---------------------------------------------------------------------------

REQUIRED_FIELDS: dict[FrameType, set[str]] = {
    FrameType.HELLO: {"plugin_id", "version", "secret", "manifest"},
    FrameType.HELLO_ACK: {"status"},
    FrameType.BUS_BROADCAST_ROOM: {"room_id", "action"},
    FrameType.BUS_NOTIFY_USER: {"username", "action"},
    FrameType.BUS_NOTIFY_ALL: {"action"},
    FrameType.BUS_REPLY: {"reply_to", "action"},
    FrameType.BUS_EMIT_EVENT: {"event_type"},
    FrameType.REGISTER_ROOM_TYPE: {"room_type", "display_name"},
    FrameType.REGISTER_FRONTEND: {"scripts"},
    FrameType.REGISTER_SETTINGS: {"settings"},
    FrameType.REGISTER_CALLBACK: {"endpoint"},
    FrameType.CORE_API_REQUEST: {"method", "request_id"},
    FrameType.CORE_API_RESPONSE: {"request_id"},
    FrameType.ROOM_ACTION: {"room_id", "action", "username", "reply_to"},
    FrameType.LIFECYCLE_ROOM_CREATED: {"room_id", "room_type", "creator"},
    FrameType.LIFECYCLE_ROOM_DELETED: {"room_id", "room_type"},
    FrameType.LIFECYCLE_USER_JOINED: {"room_id", "username"},
    FrameType.LIFECYCLE_USER_LEFT: {"room_id", "username"},
    FrameType.CALLBACK_REQUEST: {"request_id", "endpoint"},
    FrameType.CALLBACK_RESPONSE: {"request_id"},
    FrameType.EVENT: {"event_type"},
    FrameType.CONFIG_UPDATED: {"plugin_id", "key", "value"},
    FrameType.ERROR: {"code", "message"},
}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class FrameValidationError(Exception):
    """Raised when a frame fails validation."""
    def __init__(self, message: str, code: str = "invalid_frame"):
        self.message = message
        self.code = code
        super().__init__(message)


def validate_frame(data: dict) -> FrameType:
    """Validate a raw frame dict and return its FrameType.

    Raises FrameValidationError if the frame is malformed.
    """
    if not isinstance(data, dict):
        raise FrameValidationError("Frame must be a JSON object")

    raw_type = data.get("type")
    if not raw_type:
        raise FrameValidationError("Frame missing 'type' field")

    try:
        frame_type = FrameType(raw_type)
    except ValueError:
        raise FrameValidationError(f"Unknown frame type: {raw_type}", code="unknown_type")

    required = REQUIRED_FIELDS.get(frame_type, set())
    missing = required - set(data.keys())
    if missing:
        raise FrameValidationError(
            f"Frame '{raw_type}' missing required fields: {', '.join(sorted(missing))}",
            code="missing_fields",
        )

    return frame_type


def check_permission(frame_type: FrameType, permissions: set[str]) -> None:
    """Check if the given permissions allow sending this frame type.

    Raises FrameValidationError with code 'permission_denied' if not.
    """
    required = FRAME_PERMISSION_MAP.get(frame_type)
    if required and required not in permissions:
        raise FrameValidationError(
            f"Permission '{required}' required for '{frame_type.value}'",
            code="permission_denied",
        )


# ---------------------------------------------------------------------------
# Identifier validation
# ---------------------------------------------------------------------------

SAFE_IDENTIFIER_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')
# Subscriptions use "plugin_id:event_name" format — allow colon as separator
SAFE_SUBSCRIPTION_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$')


def validate_identifier(value: str, field_name: str) -> None:
    """Validate a string is a safe identifier (alphanumeric, dots, hyphens, underscores).

    Raises FrameValidationError if invalid.
    """
    if not isinstance(value, str) or not SAFE_IDENTIFIER_RE.match(value):
        raise FrameValidationError(
            f"Invalid {field_name}: must be 1-128 chars, alphanumeric/dot/hyphen/underscore, "
            f"starting with alphanumeric. Got: {value!r}",
            code="invalid_manifest",
        )


def validate_manifest(manifest: dict) -> None:
    """Validate manifest string fields against safe identifier rules.

    Raises FrameValidationError if any field is invalid.
    """
    for rt in manifest.get("room_types", []):
        validate_identifier(rt, "room_type")
    for ev in manifest.get("published_events", []):
        validate_identifier(ev, "published_event")
    for sub in manifest.get("subscriptions", []):
        if not isinstance(sub, str) or not SAFE_SUBSCRIPTION_RE.match(sub):
            raise FrameValidationError(
                f"Invalid subscription: must be 1-256 chars, alphanumeric/dot/hyphen/underscore/colon, "
                f"starting with alphanumeric. Got: {sub!r}",
                code="invalid_manifest",
            )


def error_frame(code: str, message: str, request_id: str | None = None) -> dict:
    """Build a standardised error frame."""
    frame = {"type": FrameType.ERROR.value, "code": code, "message": message}
    if request_id:
        frame["request_id"] = request_id
    return frame
