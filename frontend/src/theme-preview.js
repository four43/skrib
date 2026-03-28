/**
 * Reusable theme preview component.
 * Renders color swatches, typography, buttons, form inputs, chat messages,
 * status messages, and badges for previewing the active theme.
 */

/**
 * Returns the full theme preview HTML string.
 * @returns {string} HTML string for the theme preview
 */
export function createThemePreviewHTML() {
    return `
        <div class="theme-preview">
            <div class="preview-section">
                <div class="preview-label">Colors</div>
                <div class="preview-swatches">
                    <div class="preview-swatch preview-swatch-primary-light"><span>Light</span></div>
                    <div class="preview-swatch preview-swatch-primary"><span>Primary</span></div>
                    <div class="preview-swatch preview-swatch-primary-dark"><span>Dark</span></div>
                    <div class="preview-swatch preview-swatch-success"><span>Success</span></div>
                    <div class="preview-swatch preview-swatch-error"><span>Error</span></div>
                    <div class="preview-swatch preview-swatch-warning"><span>Warning</span></div>
                </div>
            </div>

            <div class="preview-section">
                <div class="preview-label">Typography</div>
                <div class="preview-typography">
                    <h3 style="margin:0 0 4px">Heading Text</h3>
                    <p style="margin:0 0 4px; color: var(--text-secondary)">Secondary body text for descriptions and labels.</p>
                    <p style="margin:0; color: var(--text-muted); font-size: 12px">Muted text for timestamps and metadata.</p>
                </div>
            </div>

            <div class="preview-section">
                <div class="preview-label">Buttons</div>
                <div class="preview-buttons">
                    <button class="btn-sm preview-btn" type="button">Primary</button>
                    <button class="btn-sm preview-btn approve-btn" type="button">Success</button>
                    <button class="btn-sm preview-btn reject-btn" type="button">Danger</button>
                    <button class="btn-sm preview-btn" type="button" disabled>Disabled</button>
                </div>
            </div>

            <div class="preview-section">
                <div class="preview-label">Form Input</div>
                <input type="text" class="preview-input" placeholder="Type something..." readonly>
            </div>

            <div class="preview-section">
                <div class="preview-label">Chat Messages</div>
                <div class="preview-messages">
                    <div class="preview-message">
                        <div class="preview-avatar" style="background: var(--theme-color)">A</div>
                        <div class="preview-message-content">
                            <div class="preview-message-header">
                                <span class="preview-username">alice</span>
                                <span class="preview-timestamp">12:34 PM</span>
                            </div>
                            <div class="preview-message-text">Hey, have you seen the new theme?</div>
                        </div>
                    </div>
                    <div class="preview-message">
                        <div class="preview-avatar" style="background: var(--color-success)">B</div>
                        <div class="preview-message-content">
                            <div class="preview-message-header">
                                <span class="preview-username" style="color: var(--color-success)">bob</span>
                                <span class="preview-timestamp">12:35 PM</span>
                            </div>
                            <div class="preview-message-text">Looks great! Love the colors.</div>
                        </div>
                    </div>
                    <div class="preview-system-message">
                        <span class="preview-system-text">alice set the topic to "Theme testing"</span>
                    </div>
                </div>
            </div>

            <div class="preview-section">
                <div class="preview-label">Status Messages</div>
                <div class="preview-statuses">
                    <div class="preview-status preview-status-success">Registration successful!</div>
                    <div class="preview-status preview-status-error">Connection lost. Retrying...</div>
                    <div class="preview-status preview-status-info">New update available.</div>
                </div>
            </div>

            <div class="preview-section">
                <div class="preview-label">Badges & Tags</div>
                <div class="preview-badges">
                    <span class="admin-badge" style="background: rgba(var(--theme-rgb), 0.85); display:inline-block">ADMIN</span>
                    <span class="user-role admin" style="display:inline-block">ADMIN</span>
                    <span class="user-role moderator" style="display:inline-block">MOD</span>
                    <span class="user-role user" style="display:inline-block">USER</span>
                    <span class="unread-badge" style="display:inline-block">3</span>
                </div>
            </div>
        </div>
    `;
}
