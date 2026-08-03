# Community Key: Zero-Knowledge Encryption for User Profile Data

Encrypt user profile fields (`status_emoji`, `status_text`, `nickname`) so the server never sees plaintext. Uses a shared "community key" — a single AES-256-GCM symmetric key distributed to all users via their existing RSA-OAEP public keys, following the same pattern as room keys.

## Threat Model

- **Protects against**: server DB exposure, backup leaks, hosting provider access, stolen `data/*.db` files
- **Protects against**: server operator reading user profile data (zero-knowledge)
- **Does NOT protect against**: compromised client (any logged-in user has the key)
- **Acceptable tradeoff**: all active users can read all profile data (this is already the case with plaintext)

## Design

### Concept: Virtual "Community Room"

Reuse the room key infrastructure with a well-known sentinel room ID (e.g., `__community__`). This isn't a real room — it's a key distribution channel for data that's visible to all users.

- Stored in the existing `room_keys` table with `room_id = '__community__'`
- Supports epoch rotation (same as room keys)
- Each user gets their own RSA-encrypted copy of the community key
- No new DB tables needed

### Encrypted Envelope Format

Profile fields are stored as JSON envelopes (same format as messages):

```json
{
  "v": 1,
  "epoch": 0,
  "iv": "<base64-encoded 12-byte IV>",
  "ct": "<base64-encoded ciphertext>"
}
```

The `status_emoji`, `status_text`, and `nickname` columns continue to hold TEXT, but the content is now an encrypted envelope string instead of plaintext. Unencrypted values (legacy/migration) are distinguished by the absence of `{"v":1` prefix.

### Key Lifecycle

#### Generation (first user registration)

1. First user registers and is auto-approved as admin
2. Client generates community key: `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 })`
3. Client encrypts it with their own RSA public key
4. Client stores via `POST /rooms/__community__/keys` with `key_epoch: 0`
5. Client caches the community key in memory (same as room keys)

#### Distribution (new user approved)

1. Admin approves a new user (existing flow)
2. Next time the admin's client is online, it detects the new user lacks a community key:
   - `GET /api/community-key/pending` returns usernames that have a public key but no `__community__` key entry
3. Admin's client encrypts the current-epoch community key with each pending user's RSA public key
4. Client stores via `POST /rooms/__community__/keys` for each pending user
5. This can happen from any user who already has the community key — not just admins

#### Recovery (new device / key regeneration)

Follows existing private key recovery flow:
1. User logs in on new device
2. Private key recovered via PRF or passphrase (existing flow)
3. Client fetches `GET /rooms/__community__/keys?username={self}` 
4. Decrypts community key with recovered private key
5. Profile data is now readable

#### Rotation (user removed)

1. User is revoked (existing `DELETE /users/{username}` flow)
2. Any online client with the community key detects the revocation
3. Generates a new community key at `epoch + 1`
4. Re-encrypts for all remaining active users
5. Re-encrypts own profile fields with the new epoch key
6. Other users re-encrypt their own profile fields lazily on next load

### What Gets Encrypted

| Field | Column | Encrypted |
|-------|--------|-----------|
| `status_emoji` | `users.status_emoji` | Yes — envelope string |
| `status_text` | `users.status_text` | Yes — envelope string |
| `nickname` | `users.nickname` | Yes — envelope string |
| `color` | `users.color` | No — hex code, not PII, needed for server-side identicon generation |
| `theme_name` | `users.theme_name` | No — UI preference, not PII |
| `color_scheme` | `users.color_scheme` | No — UI preference, not PII |

### WebSocket Broadcast

`system:user_updated` messages already carry status fields. No change needed — the fields are now encrypted envelope strings. All connected clients already have the community key in memory and decrypt on receive.

## Implementation Plan

### Phase 1: Community Key Infrastructure

**Backend changes:**

1. **New endpoint: `GET /api/community-key/pending`** — returns list of active usernames that have an `encryption_public_key` but no entry in `room_keys` where `room_id = '__community__'`. Requires auth (any active user).

2. **New endpoint: `POST /api/community-key/distribute`** — accepts `[{username, key_epoch, encrypted_key}]` and bulk-inserts into `room_keys` for `room_id = '__community__'`. Requires auth (any active user who already has a community key entry).

3. **Reuse existing endpoints** for key storage/retrieval:
   - `POST /rooms/__community__/keys` (store)
   - `GET /rooms/__community__/keys` (retrieve own keys)
   
   Need to relax the room membership check for the `__community__` sentinel — currently these endpoints verify room membership.

**Frontend changes (`crypto.js`):**

4. `generateCommunityKey()` — wraps `generateRoomKey()` (identical AES-GCM 256-bit)
5. `encryptProfileField(communityKey, plaintext, epoch)` — same as `encryptMessage()`
6. `decryptProfileField(communityKey, envelope)` — same as `decryptMessage()`
7. `isEncryptedField(value)` — check for `{"v":1` prefix (backward compat with plaintext)

### Phase 2: Key Distribution Flow

**Frontend changes (`app.js` or new `community-key.js`):**

8. On login (after private key resolved), fetch community key from `GET /rooms/__community__/keys`
   - If keys exist: decrypt and cache in memory
   - If no keys exist and this is the first user: generate, store, cache
   - If no keys exist for this user: they haven't been distributed yet — poll or wait for distribution

9. Background distribution check — periodically (or on `system:user_updated` for new users):
   - `GET /api/community-key/pending`
   - For each pending user: encrypt community key with their public key, POST to distribute endpoint

10. On user revocation event: trigger rotation (generate new epoch, re-encrypt for remaining users)

### Phase 3: Encrypt Profile Fields

**Frontend changes (`settings.js`):**

11. `updateUserStatus()` — encrypt `status_emoji` and `status_text` with community key before PATCH
12. Nickname update — encrypt with community key before PATCH

**Frontend changes (`app.js`):**

13. When rendering user statuses/nicknames: detect encrypted envelope, decrypt with community key
14. `system:user_updated` handler: decrypt incoming encrypted fields before updating UI state

**Backend changes:**

15. `services.py` — server no longer validates/trims plaintext (the encrypted envelope is opaque). Move length validation to the client. Server enforces a max envelope size instead (e.g., 512 bytes).

### Phase 4: Backward Compatibility & Migration

16. `isEncryptedField()` check everywhere profile fields are rendered — if it's not an envelope, display as-is (plaintext legacy data)
17. Settings page: on load, if profile fields are plaintext and community key is available, re-encrypt and save (lazy migration)
18. Seed script: either skip encryption (dev convenience) or generate a community key during seeding

## Open Questions

- **Should the community key be distributed automatically by any online user, or only by admins?** Any-user is more resilient (doesn't require an admin to be online), but admins-only is a tighter trust model. Recommendation: any user who has the key — it's already shared with everyone.

- **What happens if no user with the community key is online when a new user joins?** The new user sees encrypted blobs they can't decrypt. Options: (a) show placeholder text like "[encrypted]", (b) queue a distribution task, (c) the new user's client polls until a key appears. Recommendation: (a) + (c) — show placeholder and poll.

- **Should we encrypt room `display_name` and `topic` too?** These are room-scoped, so they'd use the room key rather than the community key. Worth doing but separate from this effort.

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/crypto.js` | Add community key helpers (thin wrappers) |
| `frontend/src/app.js` | Community key fetch/cache on login, decrypt profile fields on render, distribution check |
| `frontend/src/settings.js` | Encrypt profile fields before PATCH |
| `backend/skrib/rooms/routes.py` | Relax membership check for `__community__` sentinel |
| `backend/skrib/rooms/services.py` | Skip membership validation for `__community__` |
| `backend/skrib/users/services.py` | Replace plaintext validation with envelope size limit |
| `backend/skrib/users/routes.py` | New community-key endpoints (pending, distribute) |
| `backend/skrib/database.py` | No schema changes needed |
| `frontend/tests/e2e/` | Update status/nickname tests to handle encryption |
| `backend/tests/` | Update user service tests |
