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

**Videos:** Play overlay shown first (no auto-load). On click, streamed via Service Worker (see below). Falls back to full download if SW unavailable.

**All file downloads:** When the SW is available, downloads are streamed — the browser's native save dialog appears immediately and chunks are decrypted on the fly via a `ReadableStream`. Falls back to full in-memory decrypt + Blob URL if SW is unavailable.

## Video Streaming

### Problem

Videos are end-to-end encrypted and stored as encrypted chunks. The browser's native `<video>` element expects a URL it can make HTTP Range requests against for seeking/scrubbing. We need a layer that intercepts these range requests, maps them to encrypted chunks, decrypts on-the-fly, and returns plaintext bytes.

A thumbnail should be shown while the video is loading, and the user should be able to start playback as soon as the first chunk is ready, without waiting for the entire file to download.

### Solution: Service Worker Proxy

A Service Worker (`sw-video.js`) acts as a decrypting proxy between the browser and the encrypted chunk API. It handles two URL patterns:

- `/video-stream/{id}` — Range-aware video streaming (HTTP 206)
- `/attachment-download/{id}` — Streaming file download (ReadableStream + Content-Disposition)

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

**Autoplay:** Since the user explicitly clicks the play overlay to start loading, the `<video>` element is set to `autoplay` so playback begins as soon as data is available — no second click needed.

**Fallback:** When SW is unavailable (private browsing, insecure context), all chunks are downloaded and decrypted into a single Blob URL. No seeking until fully loaded. This should only happen once the user presses the play button, so the UX impact is minimal.

## File Downloads

### Goal

Download encrypted attachments with minimal memory usage. Ideally the save dialog appears before any chunks are fetched and bytes stream directly to disk.

### Solution: Disk-Backed Blob Assembly (working)

The key insight: browsers store `Blob` objects >256KB on disk, not in memory. By wrapping each decrypted chunk in a `Blob` immediately, the raw `ArrayBuffer` is garbage collected and the data lives on disk. When all chunks are done, `new Blob([blob1, blob2, ...])` creates a composite Blob that references the sub-Blobs already on disk — no duplication.

```text
for each chunk:
    fetch encrypted chunk from server
    AES-GCM decrypt → ArrayBuffer (~5MB in memory)
    new Blob([decrypted]) → browser moves to disk, ArrayBuffer GC'd
    peak memory: ~5MB regardless of file size

new Blob([...chunkBlobs]) → composite Blob (disk-backed)
URL.createObjectURL(blob) → triggers save dialog
```

**Peak memory: ~1 chunk (5MB)** instead of the entire file. The download button shows chunk progress (`1/5`, `2/5`...) while processing.

### Tier 1: `showSaveFilePicker` (Chrome/Edge)

When `'showSaveFilePicker' in window` is true, we can do even better: open the save dialog **first**, then write each decrypted chunk directly to the file handle via `FileSystemWritableFileStream`. True streaming — no Blob assembly, no memory accumulation, bytes hit disk as they arrive. Falls through to Tier 2 if the user cancels or the API is unavailable.

Note: `showSaveFilePicker` requires a secure context (HTTPS or localhost) and is only available in Chrome/Edge, not Firefox/Safari.

### Why not use the Service Worker for downloads?

`<a download>` navigations **bypass the SW fetch handler entirely** — this is browser spec behavior, not a bug. The SW cannot intercept download navigations, so we cannot use it to stream decrypted bytes for file downloads the way we do for video playback.

### Approaches tried and failed for SW-based streaming downloads

1. **`<iframe>` navigation to SW URL** — iframe not controlled by the page's SW; request bypasses SW → backend 404.
2. **`<a>` click (no download attr) to SW URL** — full page navigation away from the app → backend 404.
3. **`<a download>` to SW URL with ReadableStream from async `pull()`** — SW never receives the fetch event. Request goes to backend → 404.
4. **`<a download>` + TransformStream transferred to SW via `postMessage`** — Same as #3. Confirmed via `MessageChannel` that SW had the stream registered, but `<a download>` still bypasses the SW fetch handler entirely.
5. **`fetch()` + `response.blob()` from SW URL** — SW intercepted correctly (fetch IS controlled by SW), but `response.blob()` waits for the entire stream, so it's equivalent to the Blob fallback with extra overhead.
6. **Holding all decrypted `ArrayBuffer`s in memory** — the original approach before disk-backed Blob assembly. Peak memory = entire file size. Replaced by the current solution.

### TODO

- [ ] Consider the [StreamSaver.js](https://github.com/nicosommi/streamsaver-service-worker) "mitm" approach for Firefox/Safari streaming: a separate HTML page loaded in an iframe that registers its own SW and uses a `WritableStream` bridge.
- [ ] Consider showing a progress modal instead of just the button counter for large files.

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
frontend/sw-video.js   # Service Worker for video streaming + file downloads
```
