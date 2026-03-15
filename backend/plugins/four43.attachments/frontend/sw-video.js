/**
 * Service Worker — decrypting video proxy with HTTP Range support.
 *
 * The main thread registers a video (attachment metadata + raw AES key),
 * then sets <video>.src to a virtual URL within this SW's scope.
 * The browser's native video player makes standard Range requests;
 * this SW maps byte ranges → encrypted chunks → fetch + decrypt → respond.
 *
 * This gives true streaming: only the chunks needed for the current
 * playback position are fetched, and seeking/scrubbing works natively.
 *
 * NOTE: This SW is NOT used for file downloads. <a download> navigations
 * bypass the SW fetch handler entirely (browser spec behavior), so
 * downloads are handled in the main thread via Blob URL or
 * showSaveFilePicker.
 */

/* global self, caches, crypto, fetch, atob, Response, Uint8Array */

const videoRegistry = new Map(); // attachmentId → registration info
const chunkCache = new Map();    // "attachmentId:chunkIndex" → decrypted ArrayBuffer

// ─── Lifecycle ─────────────────────────────────────────────────────────

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ─── Main-thread messaging ─────────────────────────────────────────────

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'register-video') {
        videoRegistry.set(msg.attachmentId, {
            chunks: msg.chunks,     // [{iv}, …] per chunk
            rawKey: msg.rawKey,     // ArrayBuffer — exported CryptoKey
            token: msg.token,       // Bearer session token
            apiBase: msg.apiBase,   // e.g. /api/plugins/four43.attachments
            chunkSize: msg.chunkSize,
            fileSize: msg.fileSize, // original (decrypted) file size
            mimeType: msg.mimeType,
        });
    } else if (msg.type === 'unregister-video') {
        videoRegistry.delete(msg.attachmentId);
        for (const key of chunkCache.keys()) {
            if (key.startsWith(msg.attachmentId + ':')) chunkCache.delete(key);
        }
    } else if (msg.type === 'update-token') {
        for (const info of videoRegistry.values()) info.token = msg.token;
    }
});

// ─── Fetch interception ────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const match = url.pathname.match(/\/video-stream\/([a-f0-9]+)$/);
    if (!match) return; // pass through non-video requests

    const attachmentId = match[1];
    const info = videoRegistry.get(attachmentId);
    if (!info) return;

    event.respondWith(handleVideoRequest(event.request, attachmentId, info));
});

// ─── Range request handling ────────────────────────────────────────────

async function handleVideoRequest(request, attachmentId, info) {
    const { fileSize, mimeType, chunkSize } = info;
    const rangeHeader = request.headers.get('Range');

    // Normalise the requested byte range.
    // – No Range header  → treat as "bytes=0-" (first chunk only)
    // – Open-ended Range  → cap to one chunk past start so the browser
    //   doesn't wait for the entire file in a single response.
    let start = 0;
    let end;

    if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!rangeMatch) {
            return new Response('Invalid Range', { status: 416 });
        }
        start = parseInt(rangeMatch[1], 10);
        end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined;
    }

    if (start >= fileSize) {
        return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` },
        });
    }

    // Cap open-ended requests to ~2 chunks worth of data so the browser
    // gets enough to start playback but doesn't block on the whole file.
    const MAX_RESPONSE = chunkSize * 2;
    if (end === undefined) {
        end = Math.min(start + MAX_RESPONSE - 1, fileSize - 1);
    }
    const clampedEnd = Math.min(end, fileSize - 1);

    // Map the requested byte range to chunk indices
    const firstIdx = Math.floor(start / chunkSize);
    const lastIdx = Math.floor(clampedEnd / chunkSize);

    const parts = [];
    for (let i = firstIdx; i <= lastIdx; i++) {
        const decrypted = await fetchAndDecrypt(attachmentId, i, info);
        const chunkByteStart = i * chunkSize;

        const sliceStart = Math.max(0, start - chunkByteStart);
        const sliceEnd = Math.min(decrypted.byteLength, clampedEnd - chunkByteStart + 1);
        parts.push(decrypted.slice(sliceStart, sliceEnd));
    }

    const body = concatBuffers(parts);

    // Always respond with 206 so the browser knows the total size and
    // that it can issue further Range requests for seeking/scrubbing.
    return new Response(body, {
        status: 206,
        headers: {
            'Content-Type': mimeType || 'video/mp4',
            'Content-Range': `bytes ${start}-${clampedEnd}/${fileSize}`,
            'Content-Length': String(body.byteLength),
            'Accept-Ranges': 'bytes',
        },
    });
}

// ─── Chunk fetch + decrypt ─────────────────────────────────────────────

async function fetchAndDecrypt(attachmentId, chunkIndex, info) {
    const cacheKey = `${attachmentId}:${chunkIndex}`;
    if (chunkCache.has(cacheKey)) return chunkCache.get(cacheKey);

    const resp = await fetch(
        `${info.apiBase}/attachments/${attachmentId}/chunk/${chunkIndex}`,
        { headers: { 'Authorization': `Bearer ${info.token}` } },
    );
    if (!resp.ok) throw new Error(`Chunk ${chunkIndex} fetch failed: ${resp.status}`);

    const encrypted = await resp.arrayBuffer();
    const iv = new Uint8Array(base64ToArrayBuffer(info.chunks[chunkIndex].iv));
    const key = await crypto.subtle.importKey('raw', info.rawKey, 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);

    chunkCache.set(cacheKey, decrypted);
    return decrypted;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function concatBuffers(arrays) {
    const totalLen = arrays.reduce((sum, a) => sum + a.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        result.set(new Uint8Array(arr), offset);
        offset += arr.byteLength;
    }
    return result.buffer;
}
