"""Web Push Notifications Plugin — sends push notifications for new messages."""
from typing import Optional

from skrib.plugins.base import Plugin

from . import services as services_module
from . import routes as routes_module

router = routes_module.router


class WebPushPlugin(Plugin):
    """Sends Web Push notifications when users receive new messages and have no active connection."""

    def __init__(self):
        super().__init__()
        # Wire up the DB provider for services module
        services_module.init_db_provider(self.get_plugin_db)
        # Inject services into routes module
        routes_module.services = services_module

    @property
    def id(self) -> str:
        return "four43.web-push"

    @property
    def name(self) -> str:
        return "four43.web-push"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def capabilities(self) -> list[str]:
        return ["web_push"]

    def get_table_schema(self) -> Optional[str]:
        return """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        """

    async def on_startup(self):
        """Create additional tables and indexes."""
        with self.get_plugin_db() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS vapid_keys (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    public_key TEXT NOT NULL,
                    private_key TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_push_subs_username
                ON push_subscriptions(username)
            """)
            conn.commit()

        # Pre-generate VAPID keys so they're ready
        services_module.get_or_create_vapid_keys()
        self.logger.info("VAPID keys ready")

    def register_routes(self, app):
        return router

    def register_event_listeners(self, bus):
        """Listen for chat message events to trigger push notifications."""
        bus.on_event("four43.room-type-chat:message", self._handle_room_message)
        self._bus = bus

    async def _handle_room_message(self, event_data: dict):
        """Called when a four43.room-type-chat:message event is broadcast to a room.

        event_data looks like:
            {"type": "four43.room-type-chat:message", "room_id": "...", "data": {"username": "...", ...}}

        Fires once per message. We check all room members and send push
        notifications to those without active WebSocket connections.
        """
        room_id = event_data.get("room_id", "")
        msg_data = event_data.get("data", {})
        sender = msg_data.get("username", "")

        if not room_id or not sender:
            return

        try:
            from skrib.rooms.services import get_room_members

            members = get_room_members(room_id)
            _, vapid_private_key = services_module.get_or_create_vapid_keys()

            for member in members:
                if member == sender:
                    continue

                # Skip if user has active WebSocket connections
                if member in self._bus.user_connections and self._bus.user_connections[member]:
                    continue

                subs = services_module.get_subscriptions_for_user(member)
                if not subs:
                    continue

                # Build room display name
                room_label = room_id

                payload = {
                    "title": "Skrib",
                    "body": f"{sender} sent a message in {room_label}",
                    "url": f"/app.html#/r/{room_id}",
                }

                for sub in subs:
                    sub_info = {
                        "endpoint": sub["endpoint"],
                        "keys": {
                            "p256dh": sub["p256dh"],
                            "auth": sub["auth"],
                        },
                    }
                    services_module.send_push(
                        subscription_info=sub_info,
                        payload=payload,
                        vapid_private_key=vapid_private_key,
                        vapid_claims={"sub": "mailto:noreply@skrib.local"},
                    )

        except Exception as e:
            self.logger.error(f"Error sending push notification: {e}")
