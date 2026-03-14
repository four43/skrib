# four43.attachments — File Attachments Plugin

Upload, encrypt, and share file attachments in chat rooms with end-to-end encryption.

## Overview

Files are chunked (5 MB), encrypted client-side with the room's AES-GCM key, and uploaded to the server. The server only stores encrypted blobs. On download, chunks are fetched, decrypted client-side, and presented to the user.

## Architecture

### Upload Flow

1. User clicks "+" button in chat input
2. File is split into 5 MB chunks
3. Each chunk is encrypted with AES-GCM using the room key + random IV
4. Upload lifecycle:
   - `POST /rooms/{room_id}/attachments/init` — create attachment record
   - `PUT /attachments/{id}/chunk/{index}` — upload each encrypted chunk (IV in `X-Chunk-IV` header)
   - `POST /attachments/{id}/finalize` — mark complete
5. A JSON message is sent to the room with attachment metadata

### Download / Rendering

**Images:** All chunks downloaded, decrypted, rendered as `<img>` with preview sizing.

**Videos:** Streamed via Service Worker (see below). Falls back to full download if SW unavailable.

**Other files:** Download button decrypts and triggers browser save.

## Video Streaming

### Problem

Videos are end-to-end encrypted and stored as encrypted chunks. The browser's native `<video>` element expects a URL it can make HTTP Range requests against for seeking/scrubbing. We need a layer that intercepts these range requests, maps them to encrypted chunks, decrypts on-the-fly, and returns plaintext bytes.

A thumbnail should be shown while the video is loading, and the user should be able to start playback as soon as the first chunk is ready, without waiting for the entire file to download.

### Solution: Service Worker Proxy

A Service Worker (`sw-video.js`) acts as a decrypting proxy between `<video>` and the chunk API.

```
<video src="/video-stream/{id}">
    ↓ Range: bytes=5242880-10485759
Service Worker intercepts
    ↓ maps byte range → chunk indices
    ↓ GET /attachments/{id}/chunk/1
    ↓ AES-GCM decrypt
    ↓ 206 Partial Content
<video> plays seamlessly
```

**Registration flow:**

1. Main thread registers SW at `/sw-video.js` with scope `/`
2. Before playing, main thread posts `register-video` message to SW with: attachment metadata, raw AES key, auth token, API base URL
3. Video `src` set to `/video-stream/{attachmentId}`
4. SW intercepts fetches matching `/video-stream/*`, handles Range requests

**Chunk caching:** Decrypted chunks are cached in the SW to avoid re-fetching/re-decrypting on repeated seeks.

**Fallback:** When SW is unavailable (private browsing, insecure context), all chunks are downloaded and decrypted into a single Blob URL. No seeking until fully loaded. This should only happen once the user presses the play button, so the UX impact is minimal.

### Current Issues

- [ ] **Video loads entirely before playing automatically, no user input** — The fallback (full download) path is being used instead of the SW streaming path. Root cause TBD — likely SW registration or interception not working correctly. Create better log messages for this.
- [ ] Needs investigation: Is the SW registering successfully? Is it intercepting `/video-stream/*` requests?

## Backend API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/rooms/{room_id}/attachments/init` | Initialize upload |
| PUT | `/attachments/{id}/chunk/{index}` | Upload encrypted chunk |
| POST | `/attachments/{id}/finalize` | Finalize upload |
| GET | `/attachments/{id}/meta` | Get metadata (chunk count, IVs, key_epoch) |
| GET | `/attachments/{id}/chunk/{index}` | Download encrypted chunk |
| DELETE | `/attachments/{id}` | Delete attachment (author/admin) |
| GET | `/attachments/{id}/playlist.m3u8` | HLS playlist (unused currently) |
| GET | `/sw-video.js` | Serve SW with `Service-Worker-Allowed: /` |

## Frontend Components

- **Attach button** (`.four43-attach-btn`): "+" in chat input, opens file picker
- **Upload progress bar**: Shows per-chunk progress during upload
- **Attachment cards**: Rendered inline in messages for images, videos, and generic files
- **Video player**: Custom wrapper around `<video>` with loading overlay and download button

## Security

- All encryption/decryption happens client-side
- Server never sees plaintext file content
- Each chunk has its own random IV
- Key epoch tracks which room key version was used
- Room membership checked on all download operations
- Stale uploads (pending > 1 hour) are auto-cleaned

## File Structure

```
backend/routes.py      # HTTP endpoints
backend/services.py    # File storage, metadata
backend/plugin.py      # Plugin init, DB schema
frontend/src/plugin.js # UI, encryption, SW integration
frontend/plugin.css    # Styling
frontend/sw-video.js   # Service Worker for video streaming
```
