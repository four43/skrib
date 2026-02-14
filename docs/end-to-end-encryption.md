# End-to-End Encryption for Chat Rooms

Good news: You can implement E2EE for both DMs and chat rooms using the WebAuthn keys you already have! Here's how it works:

## Core Concept

WebAuthn keys can be used for both authentication AND encryption/decryption. The private key stays in the user's device hardware (TPM/secure enclave), and you can use it to:

1. **Derive encryption keys** for encrypting/decrypting messages
2. **Sign messages** to prove authenticity

## Architecture Overview

**For DMs:**

- Use recipient's public key to encrypt
- Only recipient can decrypt with their private key

**For Chat Rooms:**

- Generate a shared room key
- Encrypt room key individually for each member using their public keys
- Members decrypt the room key with their private key, then use it for messages

## Implementation Approach

### 1. Key Derivation from WebAuthn

JavaScript can't directly access the WebAuthn private key (it's in hardware), but you can:

```javascript
// Use the WebAuthn credential to sign a known value
// This creates a deterministic "encryption key"
async function deriveEncryptionKey(credentialId) {
    const challenge = new TextEncoder().encode("encryption-key-derivation");

    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge: challenge,
            allowCredentials: [{
                id: credentialId,
                type: "public-key"
            }],
            userVerification: "preferred"
        }
    });

    // Use the signature as key material
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        assertion.response.signature,
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    // Derive an AES key
    return await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: new TextEncoder().encode("room-encryption"),
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}
```

### 2. Better Approach: Hybrid Encryption

Use standard Web Crypto API with WebAuthn for key exchange:

```javascript
// Generate a key pair for each user (stored in browser)
async function generateUserKeyPair() {
    return await crypto.subtle.generateKey(
        {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256"
        },
        true,  // extractable
        ["encrypt", "decrypt"]
    );
}

// For chat rooms: symmetric key encryption
async function generateRoomKey() {
    return await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

// Encrypt a message with room key
async function encryptMessage(roomKey, message) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(message);

    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        roomKey,
        encoded
    );

    return {
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(encrypted))
    };
}

// Decrypt a message
async function decryptMessage(roomKey, encryptedData) {
    const decrypted = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: new Uint8Array(encryptedData.iv)
        },
        roomKey,
        new Uint8Array(encryptedData.ciphertext)
    );

    return new TextDecoder().decode(decrypted);
}
```

### 3. Database Schema

```sql
CREATE TABLE user_public_keys (
    user_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,  -- JWK format
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE room_keys (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    key_epoch INTEGER NOT NULL DEFAULT 0,  -- increments on key rotation
    encrypted_key TEXT NOT NULL,            -- room key encrypted with user's public key
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, user_id, key_epoch)
);
```

Messages store which epoch they were encrypted under:

```sql
-- Addition to existing messages table
key_epoch INTEGER NOT NULL DEFAULT 0
```

### 4. Room Key Distribution

```python
# Backend: Store encrypted room keys
# Each user gets the room key encrypted with their public key
# Server never sees the plaintext room key

# When room is created:
# 1. Creator generates AES room key (in JS)
# 2. Creator encrypts room key with each member's public key
# 3. Server stores encrypted keys in room_keys table

# When a new member is invited:
# 1. Inviter fetches new member's public key
# 2. Inviter encrypts room key with new member's public key
# 3. Server stores the encrypted key blob
```

### 5. Client-Side Flow

```javascript
// Room keys indexed by room + epoch
// roomKeys[roomId] = { [epoch]: CryptoKey }
const roomKeys = {};

// When joining a room:
async function joinRoom(roomId) {
    // 1. Fetch all your encrypted room keys (all epochs) from server
    const response = await fetch(`/api/rooms/${roomId}/keys`);
    const { keys } = await response.json();
    // keys = [{ key_epoch: 0, encrypted_key: "..." }, ...]

    // 2. Decrypt each epoch's key with your private key
    roomKeys[roomId] = {};
    for (const entry of keys) {
        roomKeys[roomId][entry.key_epoch] = await decryptRoomKey(entry.encrypted_key);
    }

    // 3. Decrypt messages using the epoch stored on each message
    socket.on('message', async (data) => {
        const key = roomKeys[roomId][data.key_epoch];
        const decrypted = await decryptMessage(key, data.encrypted);
        displayMessage(decrypted);
    });
}

// When sending a message, always use the latest epoch:
async function sendMessage(roomId, message) {
    const epochs = Object.keys(roomKeys[roomId]).map(Number);
    const latestEpoch = Math.max(...epochs);
    const roomKey = roomKeys[roomId][latestEpoch];
    const encrypted = await encryptMessage(roomKey, message);

    await fetch(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ encrypted, key_epoch: latestEpoch })
    });
}
```

## Inviting a User to an Encrypted Room

Only an existing member (who has the plaintext room key) can invite. The server cannot do this.

**Flow:**

1. Inviter's client fetches new member's public key from `GET /users/{username}/public-key`
2. Inviter's client encrypts the current room key with the new member's RSA public key
3. Inviter's client sends the encrypted key blob to `POST /rooms/{room_id}/keys/{username}`
4. Server stores it in `room_keys` (server never sees the plaintext key)
5. New member joins, fetches their encrypted room key from `GET /rooms/{room_id}/keys`, decrypts with their private key

**Constraint:** Invitations require an existing member to be online. If no members are online, the server queues the invite and the next online member's client processes it.

**API endpoints:**

| Method | Endpoint                           | Description                               |
| ------ | ---------------------------------- | ----------------------------------------- |
| GET    | `/rooms/{room_id}/keys`            | Get your encrypted room keys (all epochs) |
| POST   | `/rooms/{room_id}/keys/{username}` | Store an encrypted room key for a user    |
| GET    | `/users/{username}/public-key`     | Get a user's public key (JWK)             |

## Key Rotation When a Member Leaves

When a member leaves (or is removed), rotate the key **forward**. Historical messages are not re-encrypted.

**Flow:**

1. Any remaining online member generates a **new** AES room key
2. That member encrypts the new key for each **remaining** member's public key
3. Uploads all the new encrypted key blobs to the server
4. Server increments `key_epoch` on the room
5. All new messages are encrypted with the new key and tagged with the new epoch
6. Departed user never receives the new epoch key and cannot decrypt future messages

### Why historical messages are NOT re-encrypted

- The departed user already **had** the old key while they were a member
- They could have saved plaintext copies of every message they decrypted
- Re-encrypting server-side ciphertext doesn't revoke knowledge already gained
- It would be expensive (decrypt + re-encrypt every historical message) for no security benefit

This is the same approach used by Signal, Matrix, and WhatsApp: rotate forward, accept that past access is past access.

### Key epoch behavior

- Old members retain access to old epoch keys (so they can read history they were part of)
- Departed members never receive new epoch keys
- Each message is tagged with its `key_epoch` so clients know which key to decrypt with
- Clients hold all epoch keys for rooms they belong to in memory

## Implementation Strategy

**Phase 1: Public Key Storage**

1. When user registers, generate RSA key pair in browser
2. Export public key, send to server (`POST /users/{username}/public-key`)
3. Store private key in IndexedDB (encrypted with WebAuthn-derived key)

**Phase 2: Room Keys**

1. Room creator generates AES room key (epoch 0)
2. For each member, encrypt room key with their public key
3. Server stores encrypted keys (can't decrypt them)

**Phase 3: Message Encryption**

1. Client encrypts with room key before sending, tags message with `key_epoch`
2. Server stores encrypted blobs + epoch
3. Clients decrypt locally using the correct epoch key

**Phase 4: Member Invite**

1. Existing member encrypts room key for new member's public key
2. Server stores encrypted key, new member decrypts on join

**Phase 5: Key Rotation**

1. On member departure, remaining member generates new key (epoch N+1)
2. Encrypts for all remaining members, uploads to server
3. Future messages use new epoch

## Trade-offs

**Pros:**

- True E2EE: Server never sees plaintext
- Key rotation on member departure limits forward exposure
- Works with existing WebAuthn setup
- Epoch-based keys allow reading historical messages you were present for

**Cons:**

- Can't search messages on server (server only has ciphertext)
- Key management complexity (multiple epochs per room)
- Users lose messages if they lose keys
- Can't decrypt on new devices without key transfer/backup
- Inviting requires an existing member to be online
- Past messages can't be "un-known" by departed members
