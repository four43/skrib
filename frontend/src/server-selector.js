// server-selector.js — Multi-server selector (client-side only)
// Stores a list of Skrib server URLs in localStorage and renders
// a vertical icon strip for switching between instances.

import { API_URL } from './utils.js';

const SERVERS_KEY = 'skrib_servers';

export function getServers() {
    try {
        return JSON.parse(localStorage.getItem(SERVERS_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveServers(servers) {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
}

export function normalizeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return url.replace(/\/+$/, '');
    }
}

export function getCurrentServerUrl() {
    return `${window.location.protocol}//${window.location.host}`;
}

/**
 * Auto-register the current Skrib instance into the server list.
 * Called after the /api/server fetch in initializeChatView().
 */
export function registerCurrentServer(serverName) {
    const servers = getServers();
    const currentUrl = getCurrentServerUrl();
    const normalized = normalizeUrl(currentUrl);

    const existing = servers.find(s => normalizeUrl(s.url) === normalized);
    if (existing) {
        existing.name = serverName;
        existing.iconUrl = `${currentUrl}/api/server/icon`;
        saveServers(servers);
    } else {
        servers.unshift({
            url: currentUrl,
            name: serverName,
            iconUrl: `${currentUrl}/api/server/icon`,
        });
        saveServers(servers);
    }

    renderServerStrip();
}

export async function validateServer(url) {
    const base = url.replace(/\/+$/, '');
    try {
        const resp = await fetch(`${base}/api/server`, {
            mode: 'cors',
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
            return { ok: false, error: 'Server returned an error. Is this a Skrib instance?' };
        }
        const data = await resp.json();
        if (!data.name || !data.registration_mode) {
            return { ok: false, error: 'Response does not look like a Skrib server.' };
        }
        return {
            ok: true,
            name: data.name,
            iconUrl: `${base}/api/server/icon`,
        };
    } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            return { ok: false, error: 'Connection timed out. Check the URL and try again.' };
        }
        if (err instanceof TypeError) {
            return { ok: false, error: 'Could not reach server. Check the URL or CORS settings.' };
        }
        return { ok: false, error: `Unexpected error: ${err.message}` };
    }
}

export function addServer(server) {
    const servers = getServers();
    const normalized = normalizeUrl(server.url);
    if (servers.some(s => normalizeUrl(s.url) === normalized)) {
        return false;
    }
    servers.push(server);
    saveServers(servers);
    renderServerStrip();
    return true;
}

export function removeServer(url) {
    const currentUrl = normalizeUrl(getCurrentServerUrl());
    const targetUrl = normalizeUrl(url);
    if (targetUrl === currentUrl) return false;

    let servers = getServers();
    servers = servers.filter(s => normalizeUrl(s.url) !== targetUrl);
    saveServers(servers);
    renderServerStrip();
    return true;
}

export function renderServerStrip() {
    const container = document.getElementById('server-list');
    if (!container) return;

    const servers = getServers();
    const currentUrl = normalizeUrl(getCurrentServerUrl());

    // Hide strip entirely if only one server (or none)
    const strip = document.getElementById('server-strip');
    if (strip) {
        strip.classList.toggle('hidden', servers.length <= 1);
    }

    container.innerHTML = '';

    servers.forEach(server => {
        const isActive = normalizeUrl(server.url) === currentUrl;

        const item = document.createElement('div');
        item.className = `server-strip-item${isActive ? ' active' : ''}`;

        const img = document.createElement('img');
        img.src = `${server.iconUrl}?t=${Math.floor(Date.now() / 60000)}`;
        img.alt = server.name;
        img.loading = 'lazy';
        img.onerror = () => {
            img.style.display = 'none';
            const fallback = document.createElement('div');
            fallback.className = 'server-icon-fallback';
            fallback.textContent = server.name.charAt(0).toUpperCase();
            item.prepend(fallback);
        };
        item.appendChild(img);

        const tooltip = document.createElement('span');
        tooltip.className = 'server-tooltip';
        tooltip.textContent = server.name;
        item.appendChild(tooltip);

        if (!isActive) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'server-remove-btn';
            removeBtn.innerHTML = '&times;';
            removeBtn.title = 'Remove server';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Remove "${server.name}" from your server list?`)) {
                    removeServer(server.url);
                }
            });
            item.appendChild(removeBtn);
        }

        item.addEventListener('click', () => {
            if (isActive) return;
            window.location.href = server.url;
        });

        container.appendChild(item);
    });
}

export function initAddServerModal() {
    const modal = document.getElementById('add-server-modal');
    const backdrop = document.getElementById('add-server-backdrop');
    const closeBtn = document.getElementById('add-server-close-btn');
    const urlInput = document.getElementById('add-server-url-input');
    const submitBtn = document.getElementById('add-server-submit-btn');
    const preview = document.getElementById('add-server-preview');
    const previewIcon = document.getElementById('add-server-preview-icon');
    const previewName = document.getElementById('add-server-preview-name');
    const statusDiv = document.getElementById('add-server-status');
    const addBtn = document.getElementById('add-server-btn');

    if (!modal || !addBtn) return;

    let validatedServer = null;

    function openModal() {
        modal.classList.add('open');
        urlInput.value = '';
        submitBtn.disabled = true;
        preview.classList.add('hidden');
        statusDiv.innerHTML = '';
        validatedServer = null;
        setTimeout(() => urlInput.focus(), 100);
    }

    function closeModal() {
        modal.classList.remove('open');
        validatedServer = null;
    }

    addBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);

    let validateTimeout = null;
    urlInput.addEventListener('input', () => {
        clearTimeout(validateTimeout);
        submitBtn.disabled = true;
        preview.classList.add('hidden');
        statusDiv.innerHTML = '';
        validatedServer = null;

        const raw = urlInput.value.trim();
        if (!raw) return;

        let url = raw;
        if (!url.match(/^https?:\/\//i)) {
            url = 'https://' + url;
        }

        validateTimeout = setTimeout(async () => {
            statusDiv.innerHTML = '<span class="status info">Checking server...</span>';

            const result = await validateServer(url);
            if (result.ok) {
                const servers = getServers();
                const normalized = normalizeUrl(url);
                if (servers.some(s => normalizeUrl(s.url) === normalized)) {
                    statusDiv.innerHTML = '<span class="status info">This server is already in your list.</span>';
                    return;
                }

                validatedServer = {
                    url: url.replace(/\/+$/, ''),
                    name: result.name,
                    iconUrl: result.iconUrl,
                };
                previewIcon.src = result.iconUrl;
                previewName.textContent = result.name;
                preview.classList.remove('hidden');
                statusDiv.innerHTML = '';
                submitBtn.disabled = false;
            } else {
                statusDiv.innerHTML = `<span class="status error">${result.error}</span>`;
            }
        }, 600);
    });

    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && validatedServer) {
            addServer(validatedServer);
            closeModal();
        }
    });

    submitBtn.addEventListener('click', () => {
        if (!validatedServer) return;
        const added = addServer(validatedServer);
        if (added) {
            closeModal();
        } else {
            statusDiv.innerHTML = '<span class="status info">This server is already in your list.</span>';
        }
    });
}
