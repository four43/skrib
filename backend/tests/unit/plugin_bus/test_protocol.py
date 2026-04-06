"""Tests for plugin bus protocol validation and rate limiting."""
import pytest

from skrib.plugin_bus.protocol import (
    FrameType,
    validate_frame,
    validate_identifier,
    validate_manifest,
    check_permission,
    error_frame,
    FrameValidationError,
)
from skrib.plugin_bus.rate_limit import TokenBucket


def make_manifest(**overrides):
    base = {
        "id": "test.plugin",
        "version": "1.0.0",
        "permissions": ["bus.send", "bus.receive"],
        "published_events": [],
        "subscriptions": [],
    }
    base.update(overrides)
    return base


def make_hello(plugin_id="test.plugin", **manifest_overrides):
    return {
        "type": "hello",
        "plugin_id": plugin_id,
        "version": "1.0.0",
        "secret": "s3cret",
        "manifest": make_manifest(id=plugin_id, **manifest_overrides),
    }


class TestValidateFrame:
    def test_valid_hello(self):
        assert validate_frame(make_hello()) == FrameType.HELLO

    def test_missing_type(self):
        with pytest.raises(FrameValidationError, match="missing 'type'"):
            validate_frame({"plugin_id": "x"})

    def test_unknown_type(self):
        with pytest.raises(FrameValidationError, match="Unknown frame type"):
            validate_frame({"type": "bogus.type"})

    def test_missing_required_fields(self):
        with pytest.raises(FrameValidationError, match="missing required fields"):
            validate_frame({"type": "hello", "plugin_id": "x"})

    def test_not_dict(self):
        with pytest.raises(FrameValidationError, match="must be a JSON object"):
            validate_frame("not a dict")

    def test_valid_broadcast_room(self):
        frame = {"type": "bus.broadcast_room", "room_id": "r1", "action": "test"}
        assert validate_frame(frame) == FrameType.BUS_BROADCAST_ROOM

    def test_valid_notify_user(self):
        frame = {"type": "bus.notify_user", "username": "alice", "action": "ping"}
        assert validate_frame(frame) == FrameType.BUS_NOTIFY_USER

    def test_valid_register_room_type(self):
        frame = {"type": "register.room_type", "room_type": "chat", "display_name": "Chat"}
        assert validate_frame(frame) == FrameType.REGISTER_ROOM_TYPE

    def test_valid_error(self):
        frame = {"type": "error", "code": "test", "message": "fail"}
        assert validate_frame(frame) == FrameType.ERROR


class TestCheckPermission:
    def test_allowed(self):
        check_permission(FrameType.BUS_BROADCAST_ROOM, {"bus.send"})

    def test_denied(self):
        with pytest.raises(FrameValidationError) as exc_info:
            check_permission(FrameType.BUS_BROADCAST_ROOM, {"bus.receive"})
        assert exc_info.value.code == "permission_denied"

    def test_no_requirement(self):
        # Frames with no mapped permission pass always
        check_permission(FrameType.HELLO, set())
        check_permission(FrameType.HELLO_ACK, set())
        check_permission(FrameType.ERROR, set())

    def test_all_bus_send_frames(self):
        bus_send_types = [
            FrameType.BUS_BROADCAST_ROOM,
            FrameType.BUS_NOTIFY_USER,
            FrameType.BUS_NOTIFY_ALL,
            FrameType.BUS_REPLY,
            FrameType.BUS_EMIT_EVENT,
        ]
        for ft in bus_send_types:
            check_permission(ft, {"bus.send"})
            with pytest.raises(FrameValidationError):
                check_permission(ft, set())

    def test_core_api_requires_permission(self):
        check_permission(FrameType.CORE_API_REQUEST, {"core_api"})
        with pytest.raises(FrameValidationError):
            check_permission(FrameType.CORE_API_REQUEST, {"bus.send"})

    def test_register_permissions(self):
        check_permission(FrameType.REGISTER_ROOM_TYPE, {"room_type.register"})
        check_permission(FrameType.REGISTER_FRONTEND, {"frontend.register"})
        check_permission(FrameType.REGISTER_SETTINGS, {"settings.register"})
        check_permission(FrameType.REGISTER_CALLBACK, {"callbacks.register"})


class TestErrorFrame:
    def test_with_request_id(self):
        frame = error_frame("test_code", "test message", "req123")
        assert frame == {
            "type": "error",
            "code": "test_code",
            "message": "test message",
            "request_id": "req123",
        }

    def test_without_request_id(self):
        frame = error_frame("code", "msg")
        assert "request_id" not in frame
        assert frame["code"] == "code"


class TestTokenBucket:
    def test_allows_within_burst(self):
        bucket = TokenBucket(rate=10, burst=5)
        for _ in range(5):
            assert bucket.consume() is True
        assert bucket.consume() is False

    def test_refills_over_time(self):
        bucket = TokenBucket(rate=1000, burst=1)
        assert bucket.consume() is True
        assert bucket.consume() is False
        # Simulate time passing (10ms at 1000/s = 10 tokens)
        bucket._last_refill -= 0.01
        assert bucket.consume() is True

    def test_does_not_exceed_burst(self):
        bucket = TokenBucket(rate=1000, burst=3)
        # Wait a long time — tokens should cap at burst
        bucket._last_refill -= 100
        for _ in range(3):
            assert bucket.consume() is True
        assert bucket.consume() is False


# ---------------------------------------------------------------------------
# Identifier and manifest validation tests
# ---------------------------------------------------------------------------

class TestValidateIdentifier:
    def test_valid_simple(self):
        validate_identifier("chat", "test")

    def test_valid_dotted(self):
        validate_identifier("four43.room-type-chat", "test")

    def test_valid_with_underscore(self):
        validate_identifier("my_plugin_v2", "test")

    def test_rejects_empty(self):
        with pytest.raises(FrameValidationError, match="Invalid test"):
            validate_identifier("", "test")

    def test_rejects_special_chars(self):
        with pytest.raises(FrameValidationError):
            validate_identifier("<script>alert(1)</script>", "test")

    def test_rejects_spaces(self):
        with pytest.raises(FrameValidationError):
            validate_identifier("has space", "test")

    def test_rejects_starting_with_dot(self):
        with pytest.raises(FrameValidationError):
            validate_identifier(".hidden", "test")

    def test_rejects_too_long(self):
        with pytest.raises(FrameValidationError):
            validate_identifier("a" * 129, "test")

    def test_max_length_ok(self):
        validate_identifier("a" * 128, "test")


class TestValidateManifest:
    def test_valid_manifest(self):
        validate_manifest({
            "room_types": ["chat", "todo"],
            "published_events": ["message.sent"],
            "subscriptions": ["four43.web-push.notification"],
        })

    def test_empty_manifest(self):
        validate_manifest({})

    def test_invalid_room_type(self):
        with pytest.raises(FrameValidationError, match="room_type"):
            validate_manifest({"room_types": ["<bad>"]})

    def test_invalid_published_event(self):
        with pytest.raises(FrameValidationError, match="published_event"):
            validate_manifest({"published_events": ["has space"]})

    def test_invalid_subscription(self):
        with pytest.raises(FrameValidationError, match="subscription"):
            validate_manifest({"subscriptions": [""]})
