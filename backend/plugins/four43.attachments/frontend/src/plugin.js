/**
 * four43.attachments — Encrypted file attachment plugin for chat rooms.
 *
 * Injects a "+" button next to the chat input via DOM observation.
 * Handles chunked encryption, upload, message rendering, and download.
 */
const AttachmentsPlugin = (function () {
    const PLUGIN_ID = 'four43.attachments';
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB

    let ctx = null;
    let inputObserver = null;
    let messageObserver = null;
    let apiBase = '';

    // ─── Utilities ───────────────────────────────────────────────────────

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function fileIcon(mimeType) {
        if (!mimeType) return '📎';
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('video/')) return '🎬';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.includes('pdf')) return '📄';
        if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('compress')) return '📦';
        return '📎';
    }

    // ─── Encryption ──────────────────────────────────────────────────────

    async function getRoomKey() {
        const currentRoom = ctx.currentRoom();
        const roomKeys = ctx.roomKeys();
        let epochs = roomKeys[currentRoom];
        if (!epochs || Object.keys(epochs).length === 0) {
            await ctx.loadRoomKeys(currentRoom);
            epochs = ctx.roomKeys()[currentRoom];
        }
        if (!epochs || Object.keys(epochs).length === 0) {
            throw new Error('Encryption keys not available');
        }
        const epochNums = Object.keys(epochs).map(Number);
        const latestEpoch = Math.max(...epochNums);
        return { key: epochs[latestEpoch], epoch: latestEpoch };
    }

    async function encryptChunk(roomKey, chunkData) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            roomKey,
            chunkData,
        );
        return { encrypted, iv };
    }

    async function decryptChunk(roomKey, encryptedData, ivBase64) {
        const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));
        return await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            roomKey,
            encryptedData,
        );
    }

    // ─── Upload Flow ─────────────────────────────────────────────────────

    async function uploadFile(file) {
        const currentRoom = ctx.currentRoom();
        if (!currentRoom) {
            alert('Please select a room first');
            return;
        }

        const token = ctx.sessionToken();
        let progressEl = null;

        try {
            const { key: roomKey, epoch: latestEpoch } = await getRoomKey();

            // 1. Init upload
            const initResp = await fetch(`${apiBase}/rooms/${encodeURIComponent(currentRoom)}/attachments/init`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ key_epoch: latestEpoch }),
            });
            if (!initResp.ok) throw new Error('Failed to init upload');
            const { attachment_id } = await initResp.json();

            // 2. Chunk, encrypt, upload
            const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
            progressEl = showUploadProgress(file.name, 0, totalChunks);

            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunkData = await file.slice(start, end).arrayBuffer();
                const { encrypted, iv } = await encryptChunk(roomKey, chunkData);

                const chunkResp = await fetch(`${apiBase}/attachments/${attachment_id}/chunk/${i}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/octet-stream',
                        'X-Chunk-IV': arrayBufferToBase64(iv.buffer),
                    },
                    body: encrypted,
                });
                if (!chunkResp.ok) throw new Error(`Failed to upload chunk ${i}`);

                updateUploadProgress(progressEl, i + 1, totalChunks);
            }

            // 3. Finalize
            const finalResp = await fetch(`${apiBase}/attachments/${attachment_id}/finalize`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ chunk_count: totalChunks }),
            });
            if (!finalResp.ok) throw new Error('Failed to finalize upload');

            // 4. Send chat message with encrypted attachment metadata
            const attachmentMeta = JSON.stringify({
                type: 'attachment',
                attachment_id,
                filename: file.name,
                size: file.size,
                mime_type: file.type || 'application/octet-stream',
                chunks: totalChunks,
            });

            const encryptedContent = await ctx.encryptMessage(roomKey, attachmentMeta, latestEpoch);

            ctx.sendWs({
                type: 'room:message',
                room_id: currentRoom,
                content: encryptedContent,
                content_type: 'encrypted',
                key_epoch: latestEpoch,
            });
        } catch (error) {
            console.error('[Attachments] Upload failed:', error);
            alert('Failed to upload file: ' + error.message);
        } finally {
            hideUploadProgress(progressEl);
        }
    }

    // ─── Download Flow ───────────────────────────────────────────────────

    async function decryptAttachment(data) {
        const token = ctx.sessionToken();
        const currentRoom = ctx.currentRoom();

        // 1. Get metadata (includes chunk IVs and key_epoch)
        const metaResp = await fetch(`${apiBase}/attachments/${data.attachment_id}/meta`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!metaResp.ok) throw new Error('Failed to get attachment metadata');
        const meta = await metaResp.json();

        // 2. Get room key for the attachment's epoch
        const roomKeys = ctx.roomKeys();
        const epochs = roomKeys[currentRoom];
        if (!epochs) throw new Error('No room keys available');

        const roomKey = epochs[meta.key_epoch] || epochs[Object.keys(epochs).pop()];
        if (!roomKey) throw new Error('No key for this attachment');

        // 3. Download and decrypt each chunk
        const decryptedChunks = [];
        for (let i = 0; i < meta.chunks.length; i++) {
            const chunkResp = await fetch(`${apiBase}/attachments/${data.attachment_id}/chunk/${i}`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (!chunkResp.ok) throw new Error(`Failed to download chunk ${i}`);

            const encryptedData = await chunkResp.arrayBuffer();
            const decrypted = await decryptChunk(roomKey, encryptedData, meta.chunks[i].iv);
            decryptedChunks.push(decrypted);
        }

        return new Blob(decryptedChunks, {
            type: data.mime_type || 'application/octet-stream',
        });
    }

    async function downloadAttachment(data) {
        try {
            const blob = await decryptAttachment(data);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = data.filename || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('[Attachments] Download failed:', error);
            alert('Failed to download file: ' + error.message);
        }
    }

    function isPreviewable(mimeType) {
        if (!mimeType) return false;
        return mimeType.startsWith('image/') && !mimeType.includes('svg');
    }

    function isVideo(mimeType) {
        if (!mimeType) return false;
        return mimeType.startsWith('video/');
    }

    // ─── Video Streaming (Service Worker) ─────────────────────────────────
    //
    // A Service Worker acts as a decrypting proxy: it intercepts Range
    // requests from the native <video> player, maps byte ranges to
    // encrypted chunks, fetches + decrypts only what's needed, and
    // responds with standard HTTP 206 Partial Content.  This gives true
    // streaming with scrubbing — the browser only fetches the chunks
    // required for the current playback position.
    //
    // Fallback: if SW registration fails (e.g. insecure context, private
    // browsing), we load all chunks into a Blob URL instead.

    let swReady = null; // Promise<boolean>

    async function registerVideoSW() {
        if (!('serviceWorker' in navigator)) {
            console.warn('[Video SW] serviceWorker API not available (insecure context or unsupported browser)');
            return false;
        }
        try {
            const swUrl = `${apiBase}/sw-video.js`;
            console.log('[Video SW] Registering service worker from:', swUrl);
            const reg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
            console.log('[Video SW] Registration object received, state:', reg.active?.state || reg.installing?.state || reg.waiting?.state);

            // Wait for the SW to become active
            const sw = reg.active || reg.installing || reg.waiting;
            if (sw && sw.state === 'activated') {
                console.log('[Video SW] Already activated');
                return true;
            }

            return new Promise((resolve) => {
                const target = reg.installing || reg.waiting || reg.active;
                if (!target) {
                    console.warn('[Video SW] No SW target found after registration');
                    resolve(false);
                    return;
                }
                console.log('[Video SW] Waiting for activation, current state:', target.state);
                target.addEventListener('statechange', function handler() {
                    console.log('[Video SW] State changed to:', target.state);
                    if (target.state === 'activated') {
                        target.removeEventListener('statechange', handler);
                        resolve(true);
                    } else if (target.state === 'redundant') {
                        console.warn('[Video SW] Worker became redundant');
                        target.removeEventListener('statechange', handler);
                        resolve(false);
                    }
                });
            });
        } catch (e) {
            console.warn('[Video SW] Registration failed:', e.message, e);
            return false;
        }
    }

    /**
     * Get a room key for a specific room and key epoch.
     */
    async function getRoomKeyForEpoch(roomId, keyEpoch) {
        let roomKeys = ctx.roomKeys();
        let epochs = roomKeys[roomId];
        if (!epochs || Object.keys(epochs).length === 0) {
            await ctx.loadRoomKeys(roomId);
            epochs = ctx.roomKeys()[roomId];
        }
        if (!epochs) throw new Error('No room keys available');
        const roomKey = epochs[keyEpoch] || epochs[Object.keys(epochs).pop()];
        if (!roomKey) throw new Error('No key for this epoch');
        return roomKey;
    }

    /**
     * Register a video with the Service Worker so it can serve decrypted
     * byte ranges on demand.  Returns the virtual URL for the <video> src.
     */
    async function registerVideoWithSW(attachmentId, meta, roomKey, data) {
        const rawKey = await crypto.subtle.exportKey('raw', roomKey);
        navigator.serviceWorker.controller.postMessage({
            type: 'register-video',
            attachmentId,
            chunks: meta.chunks.map(c => ({ iv: c.iv })),
            rawKey,
            token: ctx.sessionToken(),
            apiBase,
            chunkSize: CHUNK_SIZE,
            fileSize: data.size,          // original (decrypted) file size
            mimeType: data.mime_type,
        });
        return `${apiBase}/video-stream/${attachmentId}`;
    }

    /**
     * Tell the SW to drop cached chunks for this attachment.
     */
    function unregisterVideoFromSW(attachmentId) {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'unregister-video',
                attachmentId,
            });
        }
    }

    /**
     * Fallback: fetch all chunks, decrypt, and create a single blob URL.
     * Used when the Service Worker is unavailable.
     */
    async function loadAllThenPlay(videoEl, progressEl, meta, roomKey, mimeType, abortSignal) {
        const totalChunks = meta.chunks.length;
        const decryptedChunks = [];

        for (let i = 0; i < totalChunks; i++) {
            if (abortSignal && abortSignal.aborted) return;

            const token = ctx.sessionToken();
            const chunkResp = await fetch(`${apiBase}/attachments/${meta.attachment_id}/chunk/${i}`, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: abortSignal,
            });
            if (!chunkResp.ok) throw new Error(`Failed to fetch chunk ${i}`);

            const encryptedData = await chunkResp.arrayBuffer();
            const decrypted = await decryptChunk(roomKey, encryptedData, meta.chunks[i].iv);
            decryptedChunks.push(decrypted);

            updateVideoProgress(progressEl, i + 1, totalChunks);
        }

        const blob = new Blob(decryptedChunks, { type: mimeType || 'video/mp4' });
        videoEl.src = URL.createObjectURL(blob);
        hideVideoLoading(progressEl);
    }

    /**
     * Main video streaming entry point.
     * Prefers Service Worker (true streaming + Range seeking).
     * Falls back to loading all chunks into a Blob.
     */
    async function streamVideo(videoEl, progressEl, data) {
        const abortController = new AbortController();

        // Abort if the video element is removed from the DOM (room switch)
        const removalObserver = new MutationObserver(() => {
            if (!document.contains(videoEl)) {
                abortController.abort();
                removalObserver.disconnect();
                unregisterVideoFromSW(data.attachment_id);
            }
        });
        removalObserver.observe(document.body, { childList: true, subtree: true });

        try {
            const token = ctx.sessionToken();
            const currentRoom = ctx.currentRoom();

            // 1. Fetch metadata
            const metaResp = await fetch(`${apiBase}/attachments/${data.attachment_id}/meta`, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: abortController.signal,
            });
            if (!metaResp.ok) throw new Error('Failed to get attachment metadata');
            const meta = await metaResp.json();

            // 2. Get room key
            const roomKey = await getRoomKeyForEpoch(currentRoom, meta.key_epoch);

            // 3. Try Service Worker streaming (true streaming with Range support)
            const hasSW = await swReady;
            console.log('[Video] SW ready:', hasSW, 'controller:', !!navigator.serviceWorker?.controller);
            if (hasSW && navigator.serviceWorker.controller) {
                console.log('[Video] Using SW streaming for attachment:', data.attachment_id);
                const streamUrl = await registerVideoWithSW(
                    data.attachment_id, meta, roomKey, data,
                );
                videoEl.src = streamUrl;
                videoEl.preload = 'metadata';
                hideVideoLoading(progressEl);
                return;
            }

            // 4. Fallback: load all chunks then play via Blob URL
            console.warn('[Video] No SW — falling back to full blob load.',
                'hasSW:', hasSW,
                'controller:', !!navigator.serviceWorker?.controller,
                'Possible causes: insecure context, private browsing, SW registration failed');
            await loadAllThenPlay(
                videoEl, progressEl, meta, roomKey,
                data.mime_type, abortController.signal,
            );
        } catch (err) {
            if (abortController.signal.aborted) return;
            console.error('[Video] Streaming failed:', err);
            const loadingText = progressEl && progressEl.querySelector('.four43-video-loading-text');
            if (loadingText) loadingText.textContent = 'Failed to load video';
        } finally {
            removalObserver.disconnect();
        }
    }

    function updateVideoProgress(progressEl, loaded, total) {
        if (!progressEl) return;
        const fill = progressEl.querySelector('.four43-video-loading-fill');
        const text = progressEl.querySelector('.four43-video-loading-text');
        if (fill) fill.style.width = `${(loaded / total) * 100}%`;
        if (text) text.textContent = `Loading video… ${loaded}/${total} chunks`;
    }

    function hideVideoLoading(el) {
        if (el) el.style.display = 'none';
    }

    function renderVideoPlayer(messageEl, data) {
        const textEl = messageEl.querySelector('.message-text');
        if (!textEl) return;

        const filename = escapeHtml(data.filename || 'video');
        const size = formatFileSize(data.size);

        textEl.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'four43-video-player';

        const video = document.createElement('video');
        video.className = 'four43-video-player-video';
        video.controls = true;
        video.playsInline = true;
        video.preload = 'none';
        video.style.display = 'none';

        // Play button overlay — shown instead of auto-loading
        const playOverlay = document.createElement('div');
        playOverlay.className = 'four43-video-play-overlay';
        playOverlay.innerHTML = `
            <button class="four43-video-play-btn" type="button" title="Play video">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <div class="four43-video-play-info">${filename} · ${size}</div>
        `;

        // Loading overlay — hidden until user clicks play
        const loading = document.createElement('div');
        loading.className = 'four43-video-loading';
        loading.style.display = 'none';
        loading.innerHTML = `
            <div class="four43-video-loading-text">Loading video…</div>
            <div class="four43-video-loading-bar">
                <div class="four43-video-loading-fill"></div>
            </div>
        `;

        const footer = document.createElement('div');
        footer.className = 'four43-attachment-preview-footer';
        footer.innerHTML = `
            <div class="four43-attachment-info">
                <span class="four43-attachment-filename">${filename}</span>
                <span class="four43-attachment-size">${size}</span>
            </div>
            <button class="four43-attachment-download-btn" type="button" title="Download">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
        `;

        footer.querySelector('.four43-attachment-download-btn').addEventListener('click', () => {
            downloadAttachment(data);
        });

        // Click play → hide overlay, show video + loading, start streaming
        playOverlay.addEventListener('click', () => {
            playOverlay.style.display = 'none';
            video.style.display = '';
            loading.style.display = '';
            streamVideo(video, loading, data);
        });

        wrapper.appendChild(playOverlay);
        wrapper.appendChild(loading);
        wrapper.appendChild(video);
        wrapper.appendChild(footer);
        textEl.appendChild(wrapper);
    }

    // ─── Progress UI ─────────────────────────────────────────────────────

    function showUploadProgress(filename, current, total) {
        // Remove any existing progress
        hideUploadProgress(document.querySelector('.four43-upload-progress'));

        const progressEl = document.createElement('div');
        progressEl.className = 'four43-upload-progress';
        progressEl.innerHTML = `
            <div class="four43-upload-progress-info">
                <span class="four43-upload-progress-filename">${escapeHtml(filename)}</span>
                <span class="four43-upload-progress-status">${current}/${total} chunks</span>
            </div>
            <div class="four43-upload-progress-bar-track">
                <div class="four43-upload-progress-bar-fill" style="width: ${total > 0 ? (current / total) * 100 : 0}%"></div>
            </div>
        `;

        const inputArea = document.getElementById('chat-input-area');
        if (inputArea) {
            inputArea.parentElement.insertBefore(progressEl, inputArea);
        }
        return progressEl;
    }

    function updateUploadProgress(progressEl, current, total) {
        if (!progressEl) return;
        const status = progressEl.querySelector('.four43-upload-progress-status');
        const fill = progressEl.querySelector('.four43-upload-progress-bar-fill');
        if (status) status.textContent = `${current}/${total} chunks`;
        if (fill) fill.style.width = `${(current / total) * 100}%`;
    }

    function hideUploadProgress(progressEl) {
        if (progressEl) progressEl.remove();
    }

    // ─── UI Injection: "+" Button ────────────────────────────────────────

    function injectAttachButton(inputArea) {
        // Don't double-inject
        if (inputArea.querySelector('.four43-attach-btn')) return;

        const wrapper = inputArea.querySelector('.input-wrapper');
        if (!wrapper) return;

        // Create "+" button
        const btn = document.createElement('button');
        btn.className = 'four43-attach-btn';
        btn.type = 'button';
        btn.title = 'Attach file';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

        // Create hidden file input
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.className = 'four43-attach-file-input';
        fileInput.style.display = 'none';

        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length > 0) {
                uploadFile(fileInput.files[0]);
                fileInput.value = ''; // Reset so same file can be re-uploaded
            }
        });

        // Create popup
        const popup = document.createElement('div');
        popup.className = 'four43-attach-popup';
        popup.style.display = 'none';

        const fileOption = document.createElement('button');
        fileOption.className = 'four43-attach-popup-item';
        fileOption.type = 'button';
        fileOption.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>File</span>';

        fileOption.addEventListener('click', (e) => {
            e.stopPropagation();
            popup.style.display = 'none';
            fileInput.click();
        });

        popup.appendChild(fileOption);

        // Container for button + popup (for positioning)
        const container = document.createElement('div');
        container.className = 'four43-attach-container';
        container.appendChild(btn);
        container.appendChild(popup);
        container.appendChild(fileInput);

        // Insert before the input wrapper
        inputArea.insertBefore(container, wrapper);

        // Toggle popup on button click
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = popup.style.display !== 'none';
            popup.style.display = isOpen ? 'none' : 'flex';
        });

        // Close popup on outside click
        document.addEventListener('click', () => {
            popup.style.display = 'none';
        });
    }

    function observeInputArea() {
        const roomContent = document.querySelector('.room-content');
        if (!roomContent) {
            setTimeout(observeInputArea, 500);
            return;
        }

        // Inject into already-existing input area
        const existing = document.getElementById('chat-input-area');
        if (existing) injectAttachButton(existing);

        // Observe for future input areas (room switches)
        inputObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.id === 'chat-input-area' || (node.querySelector && node.querySelector('#chat-input-area'))) {
                        const target = node.id === 'chat-input-area' ? node : node.querySelector('#chat-input-area');
                        if (target) injectAttachButton(target);
                    }
                }
            }
        });
        inputObserver.observe(roomContent, { childList: true, subtree: true });
    }

    // ─── Message Post-Processing ─────────────────────────────────────────

    function processMessage(messageEl) {
        // Skip if already processed or no plaintext
        if (messageEl.dataset.attachmentProcessed) return;
        const plaintext = messageEl.dataset.plaintext;
        if (!plaintext) return;

        try {
            const data = JSON.parse(plaintext);
            if (data.type !== 'attachment') return;

            messageEl.dataset.attachmentProcessed = 'true';
            renderAttachmentCard(messageEl, data);
        } catch {
            // Not JSON or not an attachment — ignore
        }
    }

    function renderAttachmentCard(messageEl, data) {
        const textEl = messageEl.querySelector('.message-text');
        if (!textEl) return;

        const size = formatFileSize(data.size);
        const filename = escapeHtml(data.filename || 'file');

        textEl.innerHTML = '';

        if (isVideo(data.mime_type)) {
            renderVideoPlayer(messageEl, data);
            return;
        }

        if (isPreviewable(data.mime_type)) {
            // Image preview with download button
            const wrapper = document.createElement('div');
            wrapper.className = 'four43-attachment-preview';

            const img = document.createElement('img');
            img.className = 'four43-attachment-preview-img';
            img.alt = data.filename || 'image';
            img.loading = 'lazy';

            // Show a placeholder while decrypting
            wrapper.innerHTML = '<div class="four43-attachment-preview-loading">Loading preview…</div>';
            wrapper.appendChild(img);

            const footer = document.createElement('div');
            footer.className = 'four43-attachment-preview-footer';
            footer.innerHTML = `
                <div class="four43-attachment-info">
                    <span class="four43-attachment-filename">${filename}</span>
                    <span class="four43-attachment-size">${size}</span>
                </div>
                <button class="four43-attachment-download-btn" type="button" title="Save">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
            `;
            wrapper.appendChild(footer);

            footer.querySelector('.four43-attachment-download-btn').addEventListener('click', () => {
                downloadAttachment(data);
            });

            textEl.appendChild(wrapper);

            // Decrypt and display inline
            decryptAttachment(data).then((blob) => {
                const url = URL.createObjectURL(blob);
                img.src = url;
                img.onload = () => {
                    const loading = wrapper.querySelector('.four43-attachment-preview-loading');
                    if (loading) loading.remove();
                };
            }).catch((err) => {
                console.error('[Attachments] Preview failed:', err);
                const loading = wrapper.querySelector('.four43-attachment-preview-loading');
                if (loading) loading.textContent = 'Preview unavailable';
            });
        } else {
            // Non-previewable: file card with icon
            const icon = fileIcon(data.mime_type);
            const card = document.createElement('div');
            card.className = 'four43-attachment-card';
            card.innerHTML = `
                <span class="four43-attachment-icon">${icon}</span>
                <div class="four43-attachment-info">
                    <span class="four43-attachment-filename">${filename}</span>
                    <span class="four43-attachment-size">${size}</span>
                </div>
                <button class="four43-attachment-download-btn" type="button" title="Download">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
            `;

            card.querySelector('.four43-attachment-download-btn').addEventListener('click', () => {
                downloadAttachment(data);
            });

            textEl.appendChild(card);
        }
    }

    function observeMessages() {
        const messagesDiv = document.getElementById('messages');
        if (!messagesDiv) {
            setTimeout(observeMessages, 500);
            return;
        }

        // Process existing messages
        messagesDiv.querySelectorAll('.message').forEach(processMessage);

        // Observe for new messages
        messageObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.classList && node.classList.contains('message')) {
                        processMessage(node);
                    }
                }
            }
        });
        messageObserver.observe(messagesDiv, { childList: true });
    }

    // ─── Escape HTML ─────────────────────────────────────────────────────

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ─── Plugin Init ─────────────────────────────────────────────────────

    async function init(context) {
        ctx = context;
        apiBase = `${ctx.API_URL}/plugins/${PLUGIN_ID}`;

        // Register the video-streaming Service Worker (non-blocking)
        swReady = registerVideoSW();

        observeInputArea();
        observeMessages();

        console.log('[Attachments] Plugin initialized');
    }

    return { init };
})();

window['Four43.attachmentsPlugin'] = AttachmentsPlugin;
