/**
 * Theme Manager for Skrīb
 *
 * Handles loading themes (CSS files) and applying user customizations.
 */

import { API_URL } from './utils.js';

const THEME_LINK_ID = 'theme-stylesheet';
const OVERRIDE_STYLE_ID = 'theme-overrides';

/**
 * Fetch list of available themes from backend.
 * @returns {Promise<string[]>} Array of theme names
 */
export async function fetchAvailableThemes() {
    try {
        const resp = await fetch(`${API_URL}/themes`);
        const data = await resp.json();
        // Backend returns List[ThemeInfo] directly (array of theme manifests)
        return Array.isArray(data) ? data : (data.themes || []);
    } catch (error) {
        console.error('[Theme] Failed to fetch themes:', error);
        return [];
    }
}

/**
 * Fetch user's theme preferences from backend.
 * @param {string} username - Username
 * @param {string} token - Session token
 * @returns {Promise<object>} Theme preferences
 */
export async function fetchUserThemePreferences(username, token) {
    try {
        const resp = await fetch(`${API_URL}/users/${encodeURIComponent(username)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        // If user hasn't set a theme, fetch server default
        if (!data.theme_name) {
            const serverResp = await fetch(`${API_URL}/server`);
            const serverInfo = await serverResp.json();
            data.theme_name = serverInfo.default_theme || 'four43.theme-default';
        }

        return data;
    } catch (error) {
        console.error('[Theme] Failed to fetch preferences:', error);
        return {
            theme_name: 'four43.theme-default',
            theme_color: null,
            nickname: null
        };
    }
}

/**
 * Save user's theme preferences to backend.
 * @param {string} token - Session token
 * @param {object} preferences - Theme preferences
 * @returns {Promise<boolean>} Success status
 */
export async function saveUserThemePreferences(token, preferences) {
    try {
        const resp = await fetch(`${API_URL}/themes/preferences/me`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(preferences)
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        return true;
    } catch (error) {
        console.error('[Theme] Failed to save preferences:', error);
        return false;
    }
}

/**
 * Load a theme's CSS file by injecting a <link> tag.
 * @param {string} themeName - Name of the theme to load
 */
export function loadThemeCSS(themeName) {
    // Remove existing theme link if present
    const existing = document.getElementById(THEME_LINK_ID);
    if (existing) {
        existing.remove();
    }

    // Create new link element for theme CSS
    const link = document.createElement('link');
    link.id = THEME_LINK_ID;
    link.rel = 'stylesheet';
    link.href = `${API_URL}/themes/${themeName}`;

    // Insert after existing stylesheets so theme overrides style.css
    document.head.appendChild(link);

    console.log(`[Theme] Loaded theme: ${themeName}`);
}

/**
 * Apply user customizations by setting CSS custom properties.
 * @param {object} overrides - User overrides
 */
export function applyUserOverrides(overrides) {
    const { font_family, font_size, primary_color, background_color } = overrides;

    // Remove existing override style if present
    let style = document.getElementById(OVERRIDE_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = OVERRIDE_STYLE_ID;
        document.head.appendChild(style);
    }

    // Build CSS content with user overrides
    const cssRules = [];

    if (font_family) {
        cssRules.push(`    --font-family: ${font_family};`);
    }

    if (font_size) {
        // Parse font size (e.g., "14px", "1rem", etc.)
        cssRules.push(`    font-size: ${font_size};`);
    }

    if (primary_color) {
        // Parse hex color to RGB for --theme-rgb
        const rgb = hexToRgb(primary_color);
        if (rgb) {
            cssRules.push(`    --theme-color: ${primary_color};`);
            cssRules.push(`    --theme-rgb: ${rgb.r}, ${rgb.g}, ${rgb.b};`);
        }
    }

    if (background_color) {
        // Apply background color gradient
        const lighter = lightenColor(background_color, 0.03);
        const darker = darkenColor(background_color, 0.03);
        cssRules.push(`    --bg-body-start: ${lighter};`);
        cssRules.push(`    --bg-body-mid: ${background_color};`);
        cssRules.push(`    --bg-body-end: ${darker};`);
    }

    // Set the CSS content
    if (cssRules.length > 0) {
        style.textContent = `:root {\n${cssRules.join('\n')}\n}`;
        console.log('[Theme] Applied user overrides:', overrides);
    } else {
        style.textContent = '';
    }
}

/**
 * Listener cleanup handle for matchMedia changes.
 * @type {function|null}
 */
let _systemPrefCleanup = null;

/**
 * Apply color scheme (auto/light/dark).
 * Stores the user preference in data-color-scheme and resolves the actual
 * dark/light state into a data-theme-dark boolean attribute that CSS targets.
 * @param {string} scheme - 'auto', 'light', or 'dark'
 */
export function applyColorScheme(scheme) {
    const value = scheme || 'auto';
    document.documentElement.setAttribute('data-color-scheme', value);

    // Clean up previous system preference listener
    if (_systemPrefCleanup) {
        _systemPrefCleanup();
        _systemPrefCleanup = null;
    }

    // Resolve whether dark mode should be active
    if (value === 'auto') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        _resolveDarkMode(mq.matches);
        const handler = (e) => _resolveDarkMode(e.matches);
        mq.addEventListener('change', handler);
        _systemPrefCleanup = () => mq.removeEventListener('change', handler);
    } else {
        _resolveDarkMode(value === 'dark');
    }

    console.log(`[Theme] Color scheme: ${value}`);
}

/**
 * Set or remove the data-theme-dark attribute on <html>.
 * @param {boolean} isDark
 */
function _resolveDarkMode(isDark) {
    document.documentElement.toggleAttribute('data-theme-dark', isDark);
}

/**
 * Load theme and apply user preferences.
 * @param {string|null} username - Username (required for authenticated users)
 * @param {string|null} token - Session token (optional, for authenticated users)
 */
export async function loadTheme(username = null, token = null) {
    if (username && token) {
        // Authenticated: fetch user preferences
        const prefs = await fetchUserThemePreferences(username, token);
        loadThemeCSS(prefs.theme_name);
        applyUserOverrides(prefs);
        applyColorScheme(prefs.color_scheme);
    } else {
        // Anonymous: fetch default theme from server
        applyColorScheme('auto');
        try {
            const resp = await fetch(`${API_URL}/server`);
            const serverInfo = await resp.json();
            loadThemeCSS(serverInfo.default_theme || 'four43.theme-default');
        } catch (error) {
            console.error('[Theme] Failed to fetch server info, using fallback theme:', error);
            loadThemeCSS('four43.theme-default');
        }
    }
}

/**
 * Convert hex color to RGB components.
 * @param {string} hex - e.g. "#6366f1"
 * @returns {{r: number, g: number, b: number}|null}
 */
function hexToRgb(hex) {
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
 * @param {number} amount - 0-1 (0.15 = 15% darker)
 * @returns {string} darkened hex color
 */
function darkenColor(hex, amount = 0.15) {
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
 * @param {number} amount - 0-1 (0.15 = 15% lighter)
 * @returns {string} lightened hex color
 */
function lightenColor(hex, amount = 0.15) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
    const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
    const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
