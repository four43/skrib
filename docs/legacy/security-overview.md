# Security Overview

> **Superseded — retained for history.** Written 2026-02-22.
>
> Superseded. Its unique content has been merged into current reference docs:
> WebSocket auth, the security-relevant `users` columns, the challenges table, and
> the residual-risk notes are now in `docs/reference/security.md`; the crypto
> material is in `docs/reference/end-to-end-encryption.md`.
>
> Retained only because it was one of three overlapping security documents and the
> merge history is worth being able to check.

---

This document describes the cryptographic architecture, authentication flows, and key recovery strategies used in Skrib.

## Authentication: WebAuthn / Passkeys

Skrib uses **WebAuthn** (FIDO2) for passwordless authentication. Users register and log in with platform authenticators (fingerprint, face, PIN) — no passwords are stored or transmitted.

### Registration Flow

1. Client requests `GET /auth/register/begin` — server generates a 256-bit random challenge (32 bytes, base64url-encoded) and stores it with a timestamp.
2. Browser calls `navigator.credentials.create()` with:
   - Resident key required (discoverable credential)
   - Platform authenticator selection
   - Supported algorithms: ES256 (alg -7) and RS256 (alg -257)
   - PRF extension requested: `{ prf: {} }` — to detect if the authenticator supports pseudo-random function output
3. Client sends the credential to `POST /auth/register/complete` — server verifies the challenge (one-time use, deleted after), validates the username, and creates the user.
4. **Approval rules:**
   - First registered user is auto-approved as admin
   - `open` mode: auto-approved as user
   - `invite_only` + valid invite token: auto-approved
   - `approval_required`: user is pending until an admin approves
5. If approved, the client proceeds to the **passphrase step** (see Key Recovery below), then generates encryption keys and uploads them.

**Username constraints:** 4–15 characters, alphanumeric + underscores, cannot contain reserved words (`admin`, `skrib`, `system`).

### Login Flow

1. Client requests `GET /auth/login/begin` — server generates a challenge.
2. Browser calls `navigator.credentials.get()` with:
   - Empty `allowCredentials` (usernameless / discoverable credential flow)
   - PRF extension: `{ prf: { eval: { first: PRF_SALT } } }` — requests a PRF output for key recovery
3. Client sends the assertion to `POST /auth/login/complete` — server looks up the user by credential ID, verifies the challenge, and returns a session token.

### Session Tokens

- **Format:** `base64url(username:64_hex_chars)` where the hex is 32 random bytes from `secrets.token_hex(32)`
- **Transport:** HTTP `Authorization: Bearer {token}` header, or WebSocket query parameter `?token={token}`
- **Validation:** Base64-decode, extract username, look up in `users` table with `status = 'active'`
- **Storage:** Client stores in `localStorage` (`session_token`, `username`, `role`)
- Tokens are stateless — there is no server-side session store.

## End-to-End Encryption

All messages are encrypted client-side before transmission. The server never has access to plaintext message content or private keys.

### User Key Pair (RSA-OAEP)

Each user has an **RSA-OAEP 2048-bit** key pair:

| Parameter | Value |
|-----------|-------|
| Algorithm | RSA-OAEP |
| Modulus length | 2048 bits |
| Hash | SHA-256 |
| Public exponent | 65537 |

- The **private key** is stored in the browser's IndexedDB (`skrib-keys` database, `keys` object store, keyed as `private:{username}`).
- The **public key** is exported as JWK and stored on the server in the `encryption_public_key` column.

### Room Keys (AES-GCM)

Each room has a symmetric **AES-GCM 256-bit** key, distributed to members encrypted with their RSA public keys:

| Parameter | Value |
|-----------|-------|
| Algorithm | AES-GCM |
| Key length | 256 bits |
| IV length | 12 bytes (random per message) |

- When a room is created, a random room key is generated and encrypted individually for each member using their RSA public key.
- Room keys are stored on the server in the `room_keys` table, encrypted per-user.

### Message Encryption

Messages are encrypted with the room's AES-GCM key. The encrypted payload format:

```json
{"v": 1, "epoch": 0, "iv": "<base64>", "ct": "<base64>"}
```

- `v`: Format version
- `epoch`: Key epoch (tracks which generation of the room key encrypted this message)
- `iv`: 12-byte random initialization vector
- `ct`: AES-GCM ciphertext (includes authentication tag)

### Key Epochs and Rotation

Room keys use an epoch counter to support key rotation. When a member's encryption key is regenerated (e.g., after key loss without recovery), the room key is rotated to a new epoch. Messages encrypted with older epochs remain tied to those keys — if the original private key is lost, those messages become unreadable.

## Key Recovery

IndexedDB is scoped per-origin (scheme + domain + port). If the origin changes (e.g., a different subdomain), the private key stored in IndexedDB is inaccessible. Skrib implements a tiered recovery strategy:

### Recovery Priority

1. **Local key** — Load from IndexedDB (same origin)
2. **PRF recovery** — Unwrap from server using authenticator's PRF output (same authenticator required, domain-bound)
3. **Passphrase recovery** — Unwrap from server using user's passphrase (domain-independent)
4. **Fresh key generation** — Last resort; old messages become unreadable

### PRF-Based Recovery

The WebAuthn PRF extension produces a deterministic pseudo-random output tied to the authenticator and the relying party ID. This output is used to derive a wrapping key:

| Parameter | Value |
|-----------|-------|
| PRF salt | `skrib-e2e-key-wrapping` (UTF-8) |
| KDF | HKDF-SHA256 |
| HKDF salt | `skrib-e2e-key-wrapping` (UTF-8) |
| HKDF info | `skrib-wrap` (UTF-8) |
| Derived key | AES-GCM 256-bit |

The derived key wraps (AES-GCM encrypts) the user's private key JWK. The wrapped blob is stored on the server in the `encrypted_private_key` column.

**Limitation:** PRF output is bound to the relying party ID (domain). If the domain changes, the PRF produces a different output and cannot unwrap the stored key.

### Passphrase-Based Recovery

During registration, the user sets a recovery passphrase. The passphrase is used to derive a wrapping key via PBKDF2:

| Parameter | Value |
|-----------|-------|
| KDF | PBKDF2 |
| Hash | SHA-256 |
| Iterations | 600,000 (OWASP 2023 recommendation) |
| Salt | 16 bytes (random, stored with blob) |
| Derived key | AES-GCM 256-bit |

The derived key wraps the private key JWK. The wrapped blob is stored on the server in the `passphrase_encrypted_private_key` column with this format:

```json
{"v": 1, "salt": "<base64>", "iv": "<base64>", "ct": "<base64>", "iterations": 600000}
```

**Passphrase requirements:**

- Minimum 32 characters
- Must contain at least one lowercase letter
- Must contain at least one uppercase letter
- Must contain at least one digit
- Must contain at least one special character

**Advantage over PRF:** Passphrase recovery is domain-independent — it works across different origins, subdomains, or devices as long as the user remembers the passphrase.

### Recovery During Login

After WebAuthn authentication succeeds, the client checks for the local private key:

**Branch 1: Local key exists**

- Load from IndexedDB, re-upload public key to server
- If PRF is available and server has no PRF backup: upload one (retroactive backup)

**Branch 2: No local key — try PRF**

- Fetch `GET /auth/encryption-key/{username}` from server
- If server has `encrypted_private_key` and PRF output is available: derive wrapping key, unwrap, store in IndexedDB

**Branch 3: No local key, no PRF — try passphrase**

- If server has `passphrase_encrypted_private_key`: show passphrase input UI
- User enters passphrase; client derives wrapping key and attempts to unwrap
- On wrong passphrase, AES-GCM authentication fails — show error, allow retry
- User can skip passphrase recovery (falls through to Branch 4)

**Branch 4: No recovery possible — generate fresh key pair**

- Generate new RSA-OAEP 2048-bit pair
- Upload new public key to server
- Set `localStorage.e2e_key_regenerated = 'true'` flag
- App displays system warning: "Your encryption key was regenerated. Messages from before this session cannot be decrypted."
- Room keys are rotated to a new epoch

## WebSocket Authentication

The WebSocket endpoint (`WS /api/ws`) authenticates via query parameter:

```
ws://host/api/ws?token={sessionToken}
```

The server decodes and validates the token the same way as HTTP bearer auth. Invalid tokens result in connection close with code 1008.

## Server-Side Storage

The server stores encrypted key material but **never** has access to:

- User private keys (only wrapped/encrypted blobs)
- Room key plaintext (only RSA-encrypted per-user blobs)
- Message plaintext (only AES-GCM ciphertext)

### Users Table (Security-Relevant Columns)

| Column | Purpose |
|--------|---------|
| `credential_id` | WebAuthn credential identifier |
| `public_key` | WebAuthn credential public key (for signature verification) |
| `encryption_public_key` | RSA-OAEP public key JWK (for encrypting room keys to this user) |
| `encrypted_private_key` | PRF-wrapped private key backup |
| `passphrase_encrypted_private_key` | Passphrase-wrapped private key backup |

### Challenges Table

WebAuthn challenges are single-use. Each challenge is stored with its type (`registration` or `login`) and timestamp, then deleted after verification.

## Threat Model Notes

- **Server compromise:** The server cannot decrypt messages or recover private keys. An attacker with server access sees only ciphertext and wrapped key blobs. Passphrase-wrapped keys are protected by PBKDF2 with 600K iterations.
- **Domain changes:** Changing the origin (e.g., different subdomain) makes IndexedDB and PRF recovery unavailable. Passphrase recovery bridges this gap.
- **Lost authenticator:** If the user loses their authenticator, they cannot log in (WebAuthn is the only auth method). The passphrase alone is not sufficient for login — it only recovers the encryption key after successful WebAuthn authentication.
- **Weak passphrase:** Enforced minimum complexity, but the passphrase-wrapped blob is stored on the server. A server-side attacker could attempt offline brute force against the PBKDF2-wrapped blob. The 600K iteration count makes this expensive but not impossible for weak passphrases.
- **CORS:** Currently configured as permissive (`*`) for development. Should be restricted in production.
