# Auth System Spec

## Overview

WebAuthn/Passkey-based authentication with no passwords transmitted to the server. Supports usernameless login (discoverable credentials), multiple registration modes, and E2E encryption key management.

## Session Model

- **Token format**: Base64-encoded `username:random_hex` string
- **Storage**: Client stores token in memory/localStorage, sends via `Authorization: Bearer {token}`
- **Validation**: Server decodes token, extracts username, checks user exists and is `status = 'active'`
- **WebSocket auth**: Token passed as query param `?token={sessionToken}`
- **No server-side session store**: The random hex portion of the token is generated but never stored or verified — only the username prefix is checked against the DB
- **No expiration**: Tokens are valid indefinitely as long as the user remains active

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

## Registration Flow (Two-Step)

### Step 1 — Username & Validation (Form POST)

```
POST /api/auth/register/step1
Content-Type: application/x-www-form-urlencoded

username=alice&invite=TOKEN   (invite is optional)
```

1. Check registration is allowed (mode + invite token)
2. Validate username (4-15 chars, alphanumeric + underscore, no reserved words)
3. Check username not taken
4. Create a `registration_step1` challenge token tied to the username
5. **303 redirect** to `/enroll-passkey.html?token=TOKEN(&invite=INVITE)`

On error: 303 redirect back to `/register.html?error=MESSAGE`.

**Why a form POST?** The password field on the registration page (type=password, no name attribute) triggers the browser's credential manager to offer saving the passphrase. The passphrase is never sent to the server.

### Step 1.5 — Token Lookup

```
GET /api/auth/register/token-info?token=TOKEN
→ { "username": "alice" }
```

The passkey enrollment page uses this to retrieve the username associated with the step-1 token.

### Step 2a — Begin WebAuthn Registration

```
GET /api/auth/register/begin?invite=TOKEN
→ { "challenge": "...", "rp": { "name": "Skrib", "id": "localhost" } }
```

Re-checks registration is allowed, generates a challenge, stores it in `challenges` table with type `registration`.

### Step 2b — Complete WebAuthn Registration

```
POST /api/auth/register/complete
{
  "username": "alice",
  "credentialId": "...",
  "publicKey": "...",
  "challenge": "...",
  "invite_token": "TOKEN",                        // optional
  "encryption_public_key": "...",                  // optional, JWK
  "passphrase_encrypted_private_key": "...",       // optional
  "encrypted_private_key": "..."                   // optional, PRF-wrapped
}
```

1. Re-check registration allowed
2. Verify & consume challenge
3. Re-validate username
4. Create user record:
   - **First user ever**: `admin` role, `active` status, auto-approved
   - **Open mode**: `user` role, `active`, approved by `OPEN_STATE`
   - **Invite mode**: `user` role, `active`, consumes invite token, approved by `INVITE`
   - **Approval-required**: `user` role, `pending` status, given an `approval_code`
5. Returns `{ "status": "approved"|"pending", "approval_code": "..." }`

## Login Flow (Usernameless)

### Begin

```
GET /api/auth/login/begin
→ { "challenge": "...", "rpId": "localhost", "allowCredentials": [] }
```

Empty `allowCredentials` enables discoverable credential flow — the browser/OS shows the user a list of available passkeys for this RP.

### Complete

```
POST /api/auth/login/complete
{ "credentialId": "...", "challenge": "..." }
→ { "session_token": "...", "username": "alice", "role": "user" }
```

1. Verify & consume challenge
2. Look up user by credential ID (must be `active`)
3. Generate session token

## Session Check

```
GET /api/auth/session
Authorization: Bearer {token}
→ { "authenticated": true, "username": "alice", "role": "user" }
```

Returns `{ "authenticated": false }` if token is missing/invalid.

## E2E Encryption Key Management

Users can store encryption keys for the end-to-end encryption system.

### Store Keys (Authenticated)

```
POST /api/auth/encryption-key
Authorization: Bearer {token}
{
  "public_key": "...",                            // JWK JSON string (required)
  "encrypted_private_key": "...",                 // PRF-wrapped private key (optional)
  "passphrase_encrypted_private_key": "..."       // Passphrase-wrapped private key (optional)
}
```

Updates the user's `encryption_public_key` and optionally the wrapped private key backups.

### Get Keys (Authenticated)

```
GET /api/auth/encryption-key/{target_username}
Authorization: Bearer {token}
→ { "username": "...", "public_key": "...", "encrypted_private_key": "...", "passphrase_encrypted_private_key": "..." }
```

Any authenticated user can fetch any other active user's public key (needed to encrypt messages to them). Also returns the wrapped private key blobs (only useful to the key owner).

## Challenge System

- Challenges are stored in a `challenges` table with: `challenge`, `type`, `username`, `timestamp`
- Types: `registration`, `registration_step1`, `login`
- Challenges are consumed (deleted) on verification — single use
- No expiration enforcement (timestamp stored but not checked)

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
