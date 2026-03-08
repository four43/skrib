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

    async function downloadAttachment(data) {
        const token = ctx.sessionToken();
        const currentRoom = ctx.currentRoom();

        try {
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

            // 4. Reassemble and trigger download
            const blob = new Blob(decryptedChunks);
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

        const icon = fileIcon(data.mime_type);
        const size = formatFileSize(data.size);
        const filename = escapeHtml(data.filename || 'file');

        textEl.innerHTML = '';

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

        observeInputArea();
        observeMessages();

        console.log('[Attachments] Plugin initialized');
    }

    return { init };
})();

window['Four43.attachmentsPlugin'] = AttachmentsPlugin;
