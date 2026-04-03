"""Web Push plugin — out-of-process version using the SDK."""
import logging

from skrib_plugin_sdk import SkribPlugin, on_event
from skrib_plugin_sdk.database import make_db_provider

from . import services as services_module
from . import routes as routes_module

logger = logging.getLogger(__name__)


class WebPushPlugin(SkribPlugin):
    id = "four43.web-push"
    version = "1.0.0"
    secret = ""
    permissions = ["bus.send", "bus.receive", "http.routes", "storage.read", "storage.write",
                   "core_api", "frontend.register"]
    subscriptions = ["four43.room-type-chat:message"]
    http_port = 0

    table_schema = """
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """

    def __init__(self):
        super().__init__()
        services_module.init_db_provider(make_db_provider(self.id))
        routes_module.services = services_module

    def register_routes(self, app):
        return routes_module.router

    async def on_connect(self):
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

        services_module.get_or_create_vapid_keys()
        logger.info("[WebPush] VAPID keys ready")

    @on_event("four43.room-type-chat:message")
    async def handle_room_message(self, ctx):
        """Send push notifications to offline members when a message is sent."""
        room_id = ctx.data.get("room_id", "")
        msg_data = ctx.data.get("data", {})
        sender = msg_data.get("username", "")

        if not room_id or not sender:
            return

        try:
            members = await self.core_api.get_room_members(room_id)
            _, vapid_private_key = services_module.get_or_create_vapid_keys()

            for member in members:
                if member == sender:
                    continue

                if await self.core_api.is_user_connected(member):
                    continue

                subs = services_module.get_subscriptions_for_user(member)
                if not subs:
                    continue

                payload = {
                    "title": "Skrib",
                    "body": f"{sender} sent a message in {room_id}",
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
            logger.error(f"Error sending push notification: {e}")
