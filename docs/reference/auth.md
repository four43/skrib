# Auth System Spec

WebAuthn/Passkey-based authentication with no passwords transmitted to the server. Supports usernameless login (discoverable credentials), multiple registration modes, and E2E encryption key management.

## User Flows

There are two primary user-facing flows. Each starts on its own HTML page and interacts with the backend API before landing the user in the app.

### 1. Registration

**Purpose**: Create a new account with a passkey and E2E encryption keys.

**Pages**: `register.html` → `enroll-passkey.html` → `app.html` (or pending approval)

```
User fills username + passphrase on register.html
  │
  ├─ Browser form POSTs to POST /api/auth/register
  │   Server validates username, registration mode, creates registration_token
  │   303 redirect → /enroll-passkey.html?registration_token=TOKEN
  │
  ├─ enroll-passkey.html loads, calls GET /api/auth/register/begin
  │   Server validates token (5 min TTL), returns challenge + username
  │   Page displays username, waits for user to click "Enroll Passkey"
  │
  ├─ User clicks button → browser WebAuthn ceremony creates a passkey
  │   Client generates E2E encryption key pair
  │   Client wraps private key with the passphrase (stored in sessionStorage)
  │
  ├─ Client calls POST /api/auth/register/complete
  │   Server verifies challenge (bound to token, 5 min TTL)
  │   Server creates user, consumes registration_token
  │
  └─ Two outcomes:
     ├─ Auto-approved → client does immediate login, redirects to app.html
     └─ Pending → shows approval code, user waits for admin
```

**Why two pages?** The registration form is a native `<form>` POST so the browser's credential manager detects the passphrase field and offers to save it. The passphrase has no `name` attribute so it's never sent to the server.

### 2. Login via Passkey (includes Key Recovery)

**Purpose**: Authenticate with an existing passkey, recover/verify E2E encryption keys, and (if needed) prompt for passphrase recovery — all on a single page.

**Pages**: `login.html` → `app.html`

```
User clicks "Sign In" on login.html
  │
  ├─ Client calls GET /api/auth/login/begin
  │   Server generates challenge (empty allowCredentials = discoverable flow)
  │   Browser/OS shows passkey picker
  │
  ├─ User authenticates → client gets assertion + PRF output (if supported)
  │
  ├─ Client calls POST /api/auth/login/complete
  │   Server verifies challenge, looks up user by credential ID
  │   Returns session_token, username, role
  │
  └─ Key recovery (3 branches):
     ├─ Local key exists → done (upload PRF backup if first time)
     ├─ PRF-wrapped key on server + PRF available → auto-recover, transparent
     ├─ Passphrase-wrapped key on server → show inline recovery form
     │   ├─ User enters passphrase → unwrap, store in IndexedDB → app.html
     │   └─ User clicks "Skip" → generate fresh key pair → app.html
     └─ No recovery possible → generate fresh key pair (loses old messages)
```

Passphrase recovery is handled inline on `login.html` via a hidden form (`#login-recovery-form`) that appears after WebAuthn authentication when a passphrase-wrapped key exists on the server but no local key is found. This eliminates the previous redirect to a separate `key-recovery.html` page.

---

## Session Model

- **Token format**: Base64-encoded `username:random_hex` string
- **Storage**: Client stores token in localStorage, sends via `Authorization: Bearer {token}`
- **Validation**: Server decodes token, extracts username, checks user exists and is `status = 'active'`
- **WebSocket auth**: Token passed as query param `?token={sessionToken}`
- **No server-side session store**: The random hex portion is generated but never stored or verified — only the username is checked against the DB
- **No expiration**: Tokens are valid indefinitely as long as the user remains active

### Known Issue: Session Token Forgery

Anyone who knows a username can forge a valid token: `base64("alice:anything")`. Fix: store tokens server-side in a `sessions` table and validate the full token on every request. This would also enable expiration, revocation, and session listing.

### Known Issue: No WebAuthn Attestation Verification

The server stores `credentialId` and `publicKey` as raw strings without cryptographic verification. A `curl` request with fabricated values creates a valid user. Fix: integrate `py_webauthn` to verify attestation on registration and assertion signatures on login.

## Roles

| Role | Access |
|------|--------|
| `admin` | Full access, user management, settings |
| `moderator` | Moderation actions |
| `user` | Standard access |

First registered user is auto-promoted to `admin`.

## Registration Modes

Configured via the `registration_mode` setting (default: `closed`).

| Mode | Behavior |
|------|----------|
| `closed` | No new registrations allowed |
| `open` | Anyone can register, auto-approved |
| `invite_only` | Requires valid invite token, auto-approved on use |
| `approval_required` | Anyone can register, but user is `pending` until an admin approves |

## API Endpoints

### Registration (3 endpoints)

#### `POST /api/auth/register`

Form POST to start registration. This is the only endpoint that checks registration mode — the registration token is proof that the gate was passed.

```
POST /api/auth/register
Content-Type: application/x-www-form-urlencoded

username=alice&invite=TOKEN   (invite is optional)
```

1. Check registration mode + invite token validity
2. Validate username (4-15 chars, alphanumeric + underscore, no reserved words)
3. Check username not taken
4. Create `registration_token` (bound to username, 5 min TTL)
5. **303 redirect** → `/enroll-passkey.html?registration_token=TOKEN(&invite=INVITE)`

On error: 303 redirect to `/register.html?error=MESSAGE`.

#### `GET /api/auth/register/begin`

Validates the registration token and returns a WebAuthn challenge + the username. Replaces the old `/register/token-info` endpoint.

```
GET /api/auth/register/begin?registration_token=TOKEN
→ { "challenge": "...", "rp": { "name": "Skrib", "id": "localhost" }, "username": "alice" }
```

- Validates registration token (exists, not expired)
- Generates challenge bound to this registration token
- Returns challenge, RP info, and username

#### `POST /api/auth/register/complete`

Completes registration. Username is derived from the token, not the request body.

```
POST /api/auth/register/complete
{
  "registration_token": "...",
  "credentialId": "...",
  "publicKey": "...",
  "challenge": "...",
  "invite_token": "TOKEN",                        // optional
  "encryption_public_key": "...",                  // optional, JWK
  "passphrase_encrypted_private_key": "...",       // optional
  "encrypted_private_key": "..."                   // optional, PRF-wrapped
}
→ { "status": "approved"|"pending", "approval_code": "..." }
```

1. Validate registration token → extract username
2. Verify challenge (must be bound to this token, 5 min TTL)
3. Create user (role/status determined by registration mode)
4. Consume (delete) registration token

User creation logic:
- **First user ever**: `admin` role, `active` status
- **Open mode**: `user` role, `active`
- **Invite mode**: `user` role, `active`, consumes invite token
- **Approval-required**: `user` role, `pending`, given `approval_code`

### Login (2 endpoints)

#### `GET /api/auth/login/begin`

```
GET /api/auth/login/begin
→ { "challenge": "...", "rpId": "localhost", "allowCredentials": [] }
```

Empty `allowCredentials` enables discoverable credential flow — browser/OS shows the user's available passkeys.

#### `POST /api/auth/login/complete`

```
POST /api/auth/login/complete
{ "credentialId": "...", "challenge": "..." }
→ { "session_token": "...", "username": "alice", "role": "user" }
```

1. Verify & consume challenge (5 min TTL)
2. Look up user by credential ID (must be `active`)
3. Generate session token

### Session

#### `GET /api/auth/session`

```
GET /api/auth/session
Authorization: Bearer {token}
→ { "authenticated": true, "username": "alice", "role": "user" }
```

Returns `{ "authenticated": false }` if token is missing/invalid.

### Encryption Keys (2 endpoints)

#### `POST /api/auth/encryption-key`

Store the user's encryption public key and optional wrapped private key backups. Requires auth.

**Public key immutability**: If a public key already exists for the user, the request must send the same key. Uploading a different public key returns `409 Conflict`. This prevents accidental or malicious key replacement — to rotate keys, the user must generate a fresh key pair (which is a separate flow that overwrites the old key).

```
POST /api/auth/encryption-key
Authorization: Bearer {token}
{
  "public_key": "...",                            // JWK JSON string (required)
  "encrypted_private_key": "...",                 // PRF-wrapped private key (optional)
  "passphrase_encrypted_private_key": "..."       // Passphrase-wrapped private key (optional)
}
```

#### `GET /api/auth/encryption-key/{username}`

Fetch an active user's public key (needed to encrypt messages to them). Requires auth.

**Access control**: Wrapped private key blobs (`encrypted_private_key`, `passphrase_encrypted_private_key`) are only returned when the requesting user matches the target username. Other users receive `null` for both fields — they only need the `public_key`.

```
GET /api/auth/encryption-key/{username}
Authorization: Bearer {token}

# Requesting own keys:
→ { "username": "alice", "public_key": "...", "encrypted_private_key": "...", "passphrase_encrypted_private_key": "..." }

# Requesting another user's keys:
→ { "username": "bob", "public_key": "...", "encrypted_private_key": null, "passphrase_encrypted_private_key": null }
```

## Challenge System

- Challenges stored in `challenges` table: `challenge`, `type`, `username`, `timestamp`
- Types: `registration_step1` (registration tokens), `registration` (WebAuthn challenges), `login`
- Single-use: consumed (deleted) on verification
- **5 minute TTL** enforced on verification — expired challenges are rejected and cleaned up
- Registration challenges are **bound to the registration token** — a challenge issued for token A cannot be used with token B

## Username Rules

- 4-15 characters
- Alphanumeric + underscores only (`^[a-zA-Z0-9_]{4,15}$`)
- Cannot contain reserved words: `admin`, `skrib`, `system`

## Invite Tokens

- Stored in `invite_tokens` table
- Single-use: marked with `used_by` and `used_at` on consumption
- Created by admins (via admin routes, not covered here)

## User Creation Details

- Each user gets a deterministic color from a 10-color palette (round-robin by total user count)
- Each user gets an auto-generated identicon avatar
- Encryption keys can be provided at registration time or stored later via the encryption-key endpoint

---

## Remaining Security Issues

Items from the original analysis that have not yet been addressed.

### S2. No rate limiting on passphrase recovery attempts (MEDIUM)

The inline passphrase recovery form retries on wrong passphrase with no throttle. An attacker with a forged session token (see Known Issue above) could script unlimited passphrase guesses against the client-side unwrap. The PBKDF2 cost (600k iterations) slows each attempt but there's no server-side limit.

**Fix**: Rate-limit `GET /encryption-key/{username}` for the owner's own wrapped keys, or add attempt tracking (e.g., 5 attempts per 15 minutes). Fixing token forgery first would make this harder to exploit remotely.

### S3. Session token forgery chains with key recovery (LOW)

Combined with the token forgery issue (see Known Issues above), an attacker who sets `localStorage` values (via XSS) can authenticate, fetch their own wrapped keys, and brute-force offline. Wrapped keys are now restricted to the owner (S1), so the attacker must forge a token for the target user specifically.

**Fix**: Fixing session token forgery breaks this chain. The inline recovery flow now requires a fresh WebAuthn assertion (passkey authentication) before the recovery form appears, which is an improvement over the old flow where a stale token was used directly.

### S5. Skip recovery silently replaces encryption identity (LOW)

When a user clicks "Skip" on the inline recovery form (or no recovery is possible), a fresh key pair is generated. The server rejects public key changes via `409 Conflict` (S4), so the old key is preserved — but a `displaySystemMessage` warns the user that old messages can't be decrypted. Other room members are not notified of the key change.

**Fix**: Notify room members when a user's encryption key changes (similar to Signal's "safety number changed" alert). Consider requiring admin approval for key rotation.

### S6. PRF salt is static, not per-user (LOW)

`PRF_SALT` is hardcoded as `'skrib-e2e-key-wrapping'` for all users. If two users share an authenticator (shared device), the PRF-derived wrapping keys could collide if the authenticator returns the same PRF output for the same salt.

**Fix**: Use `PRF_SALT = 'skrib-e2e-key-wrapping:' + username` to make the salt per-user. Low-probability issue but trivial to fix. Requires a migration path for existing PRF-wrapped keys (re-wrap with new salt on next login).

---

## Changelog

Changes from the original analysis that have been implemented:

| ID | Status | Description |
|----|--------|-------------|
| A | **Done** | Passphrase recovery merged into `login.html` as an inline form (`#login-recovery-form`). The separate `key-recovery.html` page is no longer used by the login or app flows. |
| B | **Done** | Branch 1 (local key exists) no longer re-uploads the public key on every login. The server already has it from registration. |
| C | **Done** | PRF backup upload status is cached in `localStorage` (`prf_backup_uploaded_{username}`). The server round-trip to check for an existing backup is skipped when the flag is set. |
| S1 | **Done** | `GET /encryption-key/{username}` returns wrapped private keys only to the key owner. Other users get `null` for `encrypted_private_key` and `passphrase_encrypted_private_key`. |
| S4 | **Done** | `POST /encryption-key` rejects public key changes with `409 Conflict` when an existing key differs from the uploaded one. Same-key re-uploads and first-time uploads are accepted. |
