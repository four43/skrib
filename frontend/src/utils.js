// Shared utilities

export const API_URL = import.meta.env.VITE_API_URL || '/api';

export function showStatus(elementId, message, type) {
    const statusDiv = document.getElementById(elementId);
    if (!statusDiv) {
        console.error(`showStatus: element with id '${elementId}' not found`);
        return;
    }
    statusDiv.className = `status ${type}`;
    statusDiv.innerHTML = message;
}

export function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64ToArrayBuffer(base64) {
    base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

export function friendlyError(error) {
    if (error instanceof TypeError && error.message === 'Failed to fetch') {
        return 'Could not connect to the server. Please try again later.';
    }
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
        return 'Could not connect to the server. Please try again later.';
    }
    return error.message;
}

export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Convert a hex color to RGB components.
 * @param {string} hex - e.g. "#6366f1"
 * @returns {{ r: number, g: number, b: number } | null}
 */
export function hexToRgb(hex) {
    const match = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!match) return null;
    return {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16),
    };
}

/**
 * Darken a hex color by a percentage.
 * @param {string} hex - e.g. "#6366f1"
 * @param {number} amount - 0-1, how much to darken (0.15 = 15% darker)
 * @returns {string} darkened hex color
 */
export function darkenColor(hex, amount = 0.15) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const r = Math.max(0, Math.round(rgb.r * (1 - amount)));
    const g = Math.max(0, Math.round(rgb.g * (1 - amount)));
    const b = Math.max(0, Math.round(rgb.b * (1 - amount)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Lighten a hex color by a percentage.
 * @param {string} hex - e.g. "#6366f1"
 * @param {number} amount - 0-1, how much to lighten (0.15 = 15% lighter)
 * @returns {string} lightened hex color
 */
export function lightenColor(hex, amount = 0.15) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
    const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
    const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}


