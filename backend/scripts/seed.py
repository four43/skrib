#!/usr/bin/env python3
"""Seed the Skrib database with test data for development.

Inserts the admin user (seth) from a saved row, creates fake users,
chat rooms, and messages so you have realistic data to browse in the UI.

Usage:
    cd backend && python -m scripts.seed

Requires the server to be running (rooms and messages are created via HTTP API
because the chat plugin has its own separate database).
"""
import base64
import csv
import json
import sys
import os
from collections import defaultdict

import requests
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Ensure the backend package is importable when run as `python -m scripts.seed`
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from skrib.database import init_db, get_db, get_setting, set_setting
from skrib.auth.services import create_pending_user, create_session_token

# ---------------------------------------------------------------------------
# Load seed data from external files
# ---------------------------------------------------------------------------

SEED_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed_data")


def _load_json(filename):
    with open(os.path.join(SEED_DATA_DIR, filename)) as f:
        return json.load(f)


def _load_csv(filename):
    with open(os.path.join(SEED_DATA_DIR, filename), newline="") as f:
        return list(csv.DictReader(f))


def _load_conversations():
    convos = defaultdict(list)
    with open(os.path.join(SEED_DATA_DIR, "conversations.csv"), newline="") as f:
        for row in csv.DictReader(f):
            convos[row["room_id"]].append((row["username"], row["content"]))
    return dict(convos)


def _load_reactions():
    groups = defaultdict(list)
    with open(os.path.join(SEED_DATA_DIR, "reactions.csv"), newline="") as f:
        for row in csv.DictReader(f):
            key = (row["room_id"], int(row["message_index"]))
            groups[key].append((row["username"], row["emoji"]))
    return [(room_id, msg_idx, reactions) for (room_id, msg_idx), reactions in groups.items()]


ADMIN_USER = _load_json("admin_user.json")
SEED_USERS = _load_csv("users.csv")
SEED_ROOMS = _load_csv("rooms.csv")

SEED_CONVERSATIONS = _load_conversations()
SEED_REACTIONS = _load_reactions()

PLUGIN_ID = "four43.room-type-chat"
REACTIONS_PLUGIN_ID = "four43.message-reactions"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def check_server(base_url: str) -> bool:
    """Verify the server is running."""
    try:
        resp = requests.get(f"{base_url}/api/server", timeout=3)
        return resp.status_code == 200
    except requests.ConnectionError:
        return False


# ---------------------------------------------------------------------------
# Crypto helpers (matches frontend crypto.js format)
# ---------------------------------------------------------------------------

def b64url_encode(data: bytes) -> str:
    """Base64url encode without padding (matches JS arrayBufferToBase64)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _rsa_private_key_to_jwk(private_key) -> dict:
    """Export RSA private key as a JWK dict (matches Web Crypto format)."""
    pub = private_key.public_key().public_numbers()
    priv = private_key.private_numbers()

    def _int_b64(n, length=None):
        byte_len = length or (n.bit_length() + 7) // 8
        return b64url_encode(n.to_bytes(byte_len, "big"))

    key_size = private_key.key_size // 8
    half = key_size // 2

    return {
        "kty": "RSA",
        "alg": "RSA-OAEP-256",
        "ext": True,
        "key_ops": ["decrypt"],
        "n": _int_b64(pub.n, key_size),
        "e": _int_b64(pub.e, 3),
        "d": _int_b64(priv.d, key_size),
        "p": _int_b64(priv.p, half),
        "q": _int_b64(priv.q, half),
        "dp": _int_b64(priv.dmp1, half),
        "dq": _int_b64(priv.dmq1, half),
        "qi": _int_b64(priv.iqmp, half),
    }


def _rsa_public_key_to_jwk(private_key) -> dict:
    """Export RSA public key as a JWK dict (matches Web Crypto format)."""
    pub = private_key.public_key().public_numbers()
    key_size = private_key.key_size // 8
    return {
        "kty": "RSA",
        "alg": "RSA-OAEP-256",
        "ext": True,
        "key_ops": ["encrypt"],
        "n": b64url_encode(pub.n.to_bytes(key_size, "big")),
        "e": b64url_encode(pub.e.to_bytes(3, "big")),
    }


def generate_rsa_keypair():
    """Generate an RSA-OAEP 2048-bit key pair."""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def encrypt_room_key_for_user(aes_key_bytes: bytes, rsa_private_key) -> str:
    """Encrypt a raw AES key with an RSA public key, return base64url string."""
    public_key = rsa_private_key.public_key()
    encrypted = public_key.encrypt(
        aes_key_bytes,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return b64url_encode(encrypted)


def encrypt_room_key_for_admin(aes_key_bytes: bytes) -> str:
    """Encrypt a raw AES key with the admin user's stored public key."""
    jwk = json.loads(ADMIN_USER["encryption_public_key"])
    # Reconstruct RSA public key from JWK n and e
    n_bytes = base64.urlsafe_b64decode(jwk["n"] + "==")
    e_bytes = base64.urlsafe_b64decode(jwk["e"] + "==")
    n = int.from_bytes(n_bytes, "big")
    e = int.from_bytes(e_bytes, "big")
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
    public_key = RSAPublicNumbers(e, n).public_key()
    encrypted = public_key.encrypt(
        aes_key_bytes,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return b64url_encode(encrypted)


def encrypt_message(aes_key_bytes: bytes, plaintext: str, epoch: int = 0) -> str:
    """Encrypt a message with AES-GCM, returning JSON matching frontend format."""
    iv = os.urandom(12)
    aesgcm = AESGCM(aes_key_bytes)
    ct = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
    return json.dumps({
        "v": 1,
        "epoch": epoch,
        "iv": b64url_encode(iv),
        "ct": b64url_encode(ct),
    })


# {username: rsa_private_key} — populated during user creation, used to encrypt room keys
seed_user_keys: dict = {}

# {room_id: aes_key_bytes} — populated during room key init, used to encrypt messages
room_aes_keys: dict[str, bytes] = {}


# ---------------------------------------------------------------------------
# Phase 1: Create users via direct DB
# ---------------------------------------------------------------------------

def insert_admin_user():
    """Insert the hardcoded admin user row if it doesn't already exist."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT username FROM users WHERE username = ?",
            (ADMIN_USER["username"],),
        ).fetchone()
        if existing:
            print(f"  {ADMIN_USER['username']}: already exists, skipping")
            return

        # Build the row, converting avatar from base64
        row = {k: v for k, v in ADMIN_USER.items() if k != "avatar_data_b64"}
        row["avatar_data"] = base64.b64decode(ADMIN_USER["avatar_data_b64"])

        columns = list(row.keys())
        placeholders = ", ".join("?" for _ in columns)
        col_names = ", ".join(columns)
        conn.execute(
            f"INSERT INTO users ({col_names}) VALUES ({placeholders})",
            [row[c] for c in columns],
        )
        conn.commit()
        print(f"  {ADMIN_USER['username']}: inserted (admin)")


def create_seed_users() -> dict[str, str]:
    """Create seed users, generate encryption keys, and return {username: session_token} mapping.

    Also populates the global ``seed_user_keys`` dict with RSA private keys
    so we can encrypt room keys for each user later.
    """
    global seed_user_keys

    # Temporarily set registration mode to 'open' so users are auto-approved
    original_mode = get_setting("registration_mode", "approval_required")
    set_setting("registration_mode", "open")

    tokens = {}
    for user in SEED_USERS:
        username = user["username"]

        # Check if already exists (idempotent)
        with get_db() as conn:
            row = conn.execute(
                "SELECT username FROM users WHERE username = ?", (username,)
            ).fetchone()
            if row:
                print(f"  {username}: already exists, skipping")
                tokens[username] = create_session_token(username)
                # Generate a key even for existing users (needed for room key encryption)
                if username not in seed_user_keys:
                    seed_user_keys[username] = generate_rsa_keypair()
                    pub_jwk = json.dumps(_rsa_public_key_to_jwk(seed_user_keys[username]))
                    conn.execute(
                        "UPDATE users SET encryption_public_key = ? WHERE username = ?",
                        (pub_jwk, username),
                    )
                    conn.commit()
                continue

        try:
            dummy_cred = f"seed-credential-{username}"
            dummy_key = f"seed-pubkey-{username}"
            _approval_code, auto_approved = create_pending_user(
                username, dummy_cred, dummy_key
            )
            tokens[username] = create_session_token(username)
            status = "active" if auto_approved else "pending"

            # Generate and store encryption key pair
            rsa_key = generate_rsa_keypair()
            seed_user_keys[username] = rsa_key
            pub_jwk = json.dumps(_rsa_public_key_to_jwk(rsa_key))
            with get_db() as conn:
                conn.execute(
                    "UPDATE users SET encryption_public_key = ? WHERE username = ?",
                    (pub_jwk, username),
                )
                conn.commit()

            print(f"  {username}: created ({status}) with encryption keys")
        except Exception as e:
            print(f"  {username}: ERROR - {e}")

    # Restore original registration mode
    set_setting("registration_mode", original_mode)
    return tokens


# ---------------------------------------------------------------------------
# Phase 2: Create rooms via HTTP API
# ---------------------------------------------------------------------------

def create_seed_rooms(tokens: dict[str, str], base_url: str):
    """Create rooms and add all users (seed + admin) as members."""
    # Use first seed user as room creator (will be owner)
    creator = SEED_USERS[0]["username"]
    headers = auth_headers(tokens[creator])

    all_usernames = [u["username"] for u in SEED_USERS] + [ADMIN_USER["username"]]

    for room in SEED_ROOMS:
        room_id = room["room_id"]

        # Create room
        resp = requests.post(
            f"{base_url}/api/rooms",
            json={"room_id": room_id, "room_type": "chat", "visibility": room.get("visibility", "private")},
            headers=headers,
        )
        if resp.status_code == 200:
            print(f"  #{room_id}: created")
        elif resp.status_code == 400:
            print(f"  #{room_id}: already exists, skipping creation")
        else:
            print(f"  #{room_id}: ERROR {resp.status_code} - {resp.text}")
            continue

        # Set topic
        requests.patch(
            f"{base_url}/api/rooms/{room_id}",
            json={"topic": room["topic"]},
            headers=headers,
        )

        # Add all other users as members
        for username in all_usernames:
            if username == creator:
                continue
            resp = requests.post(
                f"{base_url}/api/rooms/{room_id}/members",
                json={"username": username},
                headers=headers,
            )
            if resp.status_code == 200:
                print(f"  #{room_id}: added {username}")
            elif "already" in resp.text.lower():
                pass  # silently skip
            else:
                print(f"  #{room_id}: failed to add {username} - {resp.text}")


# ---------------------------------------------------------------------------
# Phase 2.5: Initialize room encryption keys (HTTP API)
# ---------------------------------------------------------------------------

def init_room_keys(tokens: dict[str, str], base_url: str):
    """Generate an AES-GCM room key per room and encrypt it for every member."""
    all_usernames = [u["username"] for u in SEED_USERS] + [ADMIN_USER["username"]]
    # Use the first seed user to store keys (they have room access as creator)
    creator = SEED_USERS[0]["username"]
    creator_headers = auth_headers(tokens[creator])

    for room in SEED_ROOMS:
        room_id = room["room_id"]

        # Check if keys already exist for this room
        resp = requests.get(
            f"{base_url}/api/rooms/{room_id}/keys",
            headers=creator_headers,
        )
        if resp.status_code == 200 and len(resp.json()) > 0:
            print(f"  #{room_id}: keys already exist, skipping")
            continue

        # Generate a random 256-bit AES key
        aes_key_bytes = os.urandom(32)
        room_aes_keys[room_id] = aes_key_bytes

        for username in all_usernames:
            if username == ADMIN_USER["username"]:
                encrypted = encrypt_room_key_for_admin(aes_key_bytes)
            else:
                rsa_key = seed_user_keys.get(username)
                if not rsa_key:
                    print(f"  #{room_id}: no RSA key for {username}, skipping")
                    continue
                encrypted = encrypt_room_key_for_user(aes_key_bytes, rsa_key)

            resp = requests.post(
                f"{base_url}/api/rooms/{room_id}/keys",
                json={"username": username, "encrypted_key": encrypted, "key_epoch": 0},
                headers=creator_headers,
            )
            if resp.status_code == 200:
                print(f"  #{room_id}: stored key for {username}")
            else:
                print(f"  #{room_id}: ERROR storing key for {username} - {resp.status_code} {resp.text}")


# ---------------------------------------------------------------------------
# Phase 3: Seed messages via HTTP API
# ---------------------------------------------------------------------------

def seed_messages(tokens: dict[str, str], base_url: str):
    """Post seed conversations to rooms (encrypted with room keys)."""
    for room_id, conversation in SEED_CONVERSATIONS.items():
        # Check if room already has messages (skip if so)
        check_headers = auth_headers(tokens[SEED_USERS[0]["username"]])
        resp = requests.get(
            f"{base_url}/api/plugins/{PLUGIN_ID}/rooms/{room_id}/messages?since=0",
            headers=check_headers,
        )
        if resp.status_code == 200 and len(resp.json()) > 0:
            print(f"  #{room_id}: already has messages, skipping")
            continue

        aes_key = room_aes_keys.get(room_id)

        for username, content in conversation:
            if aes_key:
                encrypted_content = encrypt_message(aes_key, content, epoch=0)
                payload = {"content": encrypted_content, "content_type": "encrypted", "key_epoch": 0}
            else:
                payload = {"content": content, "content_type": "text"}

            resp = requests.post(
                f"{base_url}/api/plugins/{PLUGIN_ID}/rooms/{room_id}/messages",
                json=payload,
                headers=auth_headers(tokens[username]),
            )
            if resp.status_code == 200:
                print(f"  #{room_id} <{username}> {content[:60]}")
            else:
                print(f"  #{room_id}: ERROR posting as {username} - {resp.status_code} {resp.text}")


# ---------------------------------------------------------------------------
# Phase 4: Seed reactions via HTTP API
# ---------------------------------------------------------------------------

def seed_reactions(tokens: dict[str, str], base_url: str):
    """Add reactions to seeded messages."""
    reactions_url = f"{base_url}/api/plugins/{REACTIONS_PLUGIN_ID}/reactions"

    # Build a map of (room_id, message_index) -> message_id by fetching messages
    message_id_cache: dict[str, list[int]] = {}

    for room_id, msg_index, reactions in SEED_REACTIONS:
        # Fetch message IDs for this room if not cached
        if room_id not in message_id_cache:
            check_headers = auth_headers(tokens[SEED_USERS[0]["username"]])
            resp = requests.get(
                f"{base_url}/api/plugins/{PLUGIN_ID}/rooms/{room_id}/messages?since=0",
                headers=check_headers,
            )
            if resp.status_code != 200:
                print(f"  #{room_id}: ERROR fetching messages - {resp.status_code}")
                continue
            # Store message IDs in order
            message_id_cache[room_id] = [msg["id"] for msg in resp.json()]

        msg_ids = message_id_cache[room_id]
        if msg_index >= len(msg_ids):
            print(f"  #{room_id}: message index {msg_index} out of range ({len(msg_ids)} messages)")
            continue

        message_id = msg_ids[msg_index]

        for username, emoji in reactions:
            resp = requests.post(
                f"{reactions_url}/add",
                json={"message_id": message_id, "room_id": room_id, "emoji": emoji},
                headers=auth_headers(tokens[username]),
            )
            if resp.status_code == 200:
                print(f"  #{room_id} msg:{message_id} {emoji} by {username}")
            elif resp.status_code == 400 and "already exists" in resp.text.lower():
                pass  # silently skip duplicates
            else:
                print(f"  #{room_id}: ERROR reacting as {username} - {resp.status_code} {resp.text}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    base_url = os.environ.get("SKRIB_URL", "http://localhost:8000")

    # Phase 1: Direct DB — create users
    print("\n=== Phase 1: Creating users (direct DB) ===")
    init_db()
    insert_admin_user()
    tokens = create_seed_users()

    if not tokens:
        print("ERROR: No seed users created. Check errors above.")
        sys.exit(1)

    # Check server is running for HTTP phases
    print(f"\n=== Checking server at {base_url} ===")
    if not check_server(base_url):
        print("ERROR: Server is not running. Start it first:")
        print("  cd backend && uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000")
        sys.exit(1)
    print("Server is up!")

    # Phase 2: HTTP API — create rooms and add all users
    print("\n=== Phase 2: Creating rooms (HTTP API) ===")
    create_seed_rooms(tokens, base_url)

    # Phase 2.5: HTTP API — initialize room encryption keys
    print("\n=== Phase 2.5: Initializing room encryption keys (HTTP API) ===")
    init_room_keys(tokens, base_url)

    # Phase 3: HTTP API — seed encrypted messages
    print("\n=== Phase 3: Seeding messages (HTTP API) ===")
    seed_messages(tokens, base_url)

    # Phase 4: HTTP API — seed reactions
    print("\n=== Phase 4: Seeding reactions (HTTP API) ===")
    seed_reactions(tokens, base_url)

    print("\n=== Done! Refresh your browser to see the seeded data. ===")


if __name__ == "__main__":
    main()
