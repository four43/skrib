"""Web Push services: VAPID key management, subscription CRUD, push sending."""
import base64
import json
import traceback

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from pywebpush import webpush, WebPushException
from py_vapid import Vapid

# DB provider — set by plugin.py during init
_get_db = None


def init_db_provider(get_db_fn):
    global _get_db
    _get_db = get_db_fn


def _encode_public_key(vapid: Vapid) -> str:
    """Encode VAPID public key as URL-safe base64 (applicationServerKey format)."""
    raw = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _encode_private_key(vapid: Vapid) -> str:
    """Encode VAPID private key as URL-safe base64."""
    raw = vapid.private_key.private_numbers().private_value.to_bytes(32, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def get_or_create_vapid_keys():
    """Return (public_key, private_key) as URL-safe base64 strings."""
    with _get_db() as conn:
        row = conn.execute("SELECT public_key, private_key FROM vapid_keys WHERE id = 1").fetchone()
        if row:
            return row["public_key"], row["private_key"]

        # Generate new VAPID key pair
        vapid = Vapid()
        vapid.generate_keys()

        public_key = _encode_public_key(vapid)
        private_key = _encode_private_key(vapid)

        conn.execute(
            "INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)",
            (public_key, private_key),
        )
        conn.commit()
        return public_key, private_key


def save_subscription(username: str, endpoint: str, p256dh: str, auth: str):
    """Save or update a push subscription for a user."""
    with _get_db() as conn:
        conn.execute(
            """INSERT INTO push_subscriptions (username, endpoint, p256dh, auth)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET
                   username = excluded.username,
                   p256dh = excluded.p256dh,
                   auth = excluded.auth""",
            (username, endpoint, p256dh, auth),
        )
        conn.commit()


def remove_subscription(username: str, endpoint: str):
    """Remove a specific subscription."""
    with _get_db() as conn:
        conn.execute(
            "DELETE FROM push_subscriptions WHERE username = ? AND endpoint = ?",
            (username, endpoint),
        )
        conn.commit()


def remove_subscription_by_endpoint(endpoint: str):
    """Remove a subscription by endpoint (e.g. on 410 Gone)."""
    with _get_db() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        conn.commit()


def get_subscriptions_for_user(username: str) -> list[dict]:
    """Get all push subscriptions for a user."""
    with _get_db() as conn:
        rows = conn.execute(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username = ?",
            (username,),
        ).fetchall()
        return [dict(r) for r in rows]


def send_push(subscription_info: dict, payload: dict, vapid_private_key: str, vapid_claims: dict):
    """Send a Web Push notification. Returns True on success, False on failure.

    Removes the subscription on 404/410 (expired/unsubscribed).
    """
    try:
        webpush(
            subscription_info=subscription_info,
            data=json.dumps(payload),
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
        )
        return True
    except WebPushException as e:
        status_code = e.response.status_code if e.response is not None else None
        if status_code in (404, 410):
            # Subscription is gone — clean it up
            remove_subscription_by_endpoint(subscription_info["endpoint"])
        else:
            traceback.print_exc()
        return False
