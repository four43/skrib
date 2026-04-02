# Auth System Spec

WebAuthn/Passkey-based authentication with no passwords transmitted to the server. Supports usernameless login (discoverable credentials), multiple registration modes, and E2E encryption key management.

## User Flows

There are three primary user-facing flows. Each starts on its own HTML page and interacts with the backend API before landing the user in the app.

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

### 2. Login via Passkey

**Purpose**: Authenticate with an existing passkey and recover/verify E2E encryption keys.

**Pages**: `login.html` → `app.html` (or `key-recovery.html` if local key is missing)

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
  └─ Key recovery (4 branches):
     ├─ Local key exists → re-upload public key, optionally upload PRF backup
     ├─ PRF-wrapped key on server + PRF available → auto-recover, transparent
     ├─ Passphrase-wrapped key on server → redirect to key-recovery.html
     └─ No recovery possible → generate fresh key pair (loses old messages)
```

### 3. Key Recovery via Passphrase

**Purpose**: Restore the E2E private key when the local IndexedDB key is lost but a passphrase-wrapped backup exists on the server.

**Pages**: `key-recovery.html` → `app.html`

```
User is already authenticated (redirected here from login flow)
  │
  ├─ Page fetches GET /api/auth/encryption-key/{username}
  │   Gets passphrase_encrypted_private_key blob from server
  │
  ├─ User enters their passphrase
  │   Client unwraps private key, stores in IndexedDB
  │   Client re-uploads public key for consistency
  │   Redirect → app.html
  │
  └─ Alternative: user clicks "Skip" → generates fresh key pair
     (loses ability to decrypt old messages)
```

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

Fetch any active user's public key (needed to encrypt messages to them). Also returns wrapped private key blobs (only useful to the key owner for recovery). Requires auth.

```
GET /api/auth/encryption-key/{username}
Authorization: Bearer {token}
→ { "username": "...", "public_key": "...", "encrypted_private_key": "...", "passphrase_encrypted_private_key": "..." }
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
