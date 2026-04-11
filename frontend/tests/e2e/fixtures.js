/**
 * Shared test fixtures for E2E tests.
 *
 * - _backend        (test-scoped) — fresh uvicorn backend + empty DB per test
 * - baseURL         — points at the per-test backend
 * - authenticatedPage — Page with a CTAP2 virtual WebAuthn authenticator
 * - registeredUser  — registers a fresh user through the full UI flow
 * - twoUsers        — two registered users (first is admin, second is approved)
 */

import { test as base, expect } from '@playwright/test';
import { spawn, execSync } from 'child_process';
import { createServer } from 'net';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Backend source lives in the worktree, but the venv may be in the main repo.
const BACKEND_DIR = resolve(process.cwd(), '..', 'backend');

function findVenvPython() {
    // Check worktree backend first
    const local = join(BACKEND_DIR, '.venv', 'bin', 'python');
    if (existsSync(local)) return local;
    // Fall back to main repo (for git worktree checkouts)
    try {
        const mainRoot = execSync('git worktree list --porcelain', { cwd: BACKEND_DIR, encoding: 'utf8' })
            .split('\n').find(l => l.startsWith('worktree '))?.replace('worktree ', '');
        if (mainRoot) {
            const mainVenv = join(mainRoot, 'backend', '.venv', 'bin', 'python');
            if (existsSync(mainVenv)) return mainVenv;
        }
    } catch {}
    // Last resort: hope it's on PATH
    return 'python';
}

const VENV_PYTHON = findVenvPython();

// Unique counter per worker so usernames don't collide across tests
let userCounter = 0;

/**
 * Generate a passphrase that satisfies validation:
 *   32+ chars, uppercase, lowercase, number, special char
 */
function generatePassphrase() {
    return 'Test-Passphrase-1234!abcdefghijk';
}

/**
 * Find a free TCP port by briefly binding to port 0.
 */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/**
 * Spawn an isolated backend (uvicorn) with a fresh SQLite DB per test.
 * Uses OS-assigned free ports to avoid conflicts between concurrent tests.
 */
export const test = base.extend({

    // ---------- test-scoped: fresh backend + empty DB per test ----------
    _backend: [async ({}, use) => {
        const port = await getFreePort();
        const dataDir = mkdtempSync(join(tmpdir(), 'skrib-e2e-'));

        const proc = spawn(VENV_PYTHON, ['-m', 'uvicorn', 'skrib.main:app', '--host', '0.0.0.0', '--port', String(port)], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                SKRIB_DATA_DIR: dataDir,
                SKRIB_RP_ID: 'localhost',
                PYTHONPATH: BACKEND_DIR,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Drain stdout/stderr so pipe buffers don't fill up and block uvicorn
        proc.stdout.resume();
        proc.stderr.resume();

        // Wait for the server to be ready
        const baseURL = `http://localhost:${port}`;
        await waitForServer(baseURL, 15_000);

        await use({ port, baseURL, dataDir, proc });

        // Teardown: kill server and remove temp data
        proc.kill('SIGTERM');
        const exited = await Promise.race([
            new Promise(resolve => proc.on('exit', resolve)).then(() => true),
            new Promise(resolve => setTimeout(resolve, 5_000)).then(() => false),
        ]);
        if (!exited) proc.kill('SIGKILL');
        try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }, { scope: 'test', auto: true }],

    // ---------- override baseURL to point at the per-test backend ----------
    baseURL: async ({ _backend }, use) => {
        await use(_backend.baseURL);
    },

    // ---------- Page with a virtual WebAuthn authenticator ----------
    authenticatedPage: async ({ browser, baseURL }, use) => {
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();

        const client = await context.newCDPSession(page);
        await client.send('WebAuthn.enable');
        const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
            options: {
                protocol: 'ctap2',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });

        await use(page);

        // Cleanup
        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
        await client.send('WebAuthn.disable');
        await context.close();
    },

    // ---------- Register a fresh user via the full UI flow ----------
    registeredUser: async ({ browser, baseURL }, use) => {
        const result = await registerNewUser(browser, baseURL);
        await use(result);
        await result.context.close();
    },

    // ---------- Two registered users: first is admin, second is approved ----------
    twoUsers: async ({ browser, baseURL }, use) => {
        // Register first user (auto-approved as admin)
        const admin = await registerNewUser(browser, baseURL);

        // Register second user (will be pending)
        const user = await registerNewUser(browser, baseURL);

        // Admin approves the second user via API
        const approvalCode = user.approvalCode;
        const resp = await admin.page.request.patch(
            `${baseURL}/api/users/pending/${encodeURIComponent(approvalCode)}`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${admin.sessionToken}`,
                },
                data: { status: 'approved' },
            }
        );
        expect(resp.ok()).toBeTruthy();

        await use({ admin, user });

        await admin.context.close();
        await user.context.close();
    },

    // ---------- Three registered, approved, and logged-in users ----------
    threeUsers: async ({ browser, baseURL }, use) => {
        // Register User A (auto-approved admin) — lands on app.html
        const admin = await registerNewUser(browser, baseURL);

        // Register User B and User C (pending)
        const userB = await registerNewUser(browser, baseURL);
        const userC = await registerNewUser(browser, baseURL);

        // Admin approves both
        for (const u of [userB, userC]) {
            const resp = await admin.page.request.patch(
                `${baseURL}/api/users/pending/${encodeURIComponent(u.approvalCode)}`,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${admin.sessionToken}`,
                    },
                    data: { status: 'approved' },
                }
            );
            expect(resp.ok()).toBeTruthy();
        }

        // Log User B and User C in via passkey
        for (const u of [userB, userC]) {
            await u.page.goto('/login.html');
            await u.page.locator('#login-button').click();
            await u.page.waitForURL('**/app.html**', { timeout: 15_000 });
            u.sessionToken = await u.page.evaluate(() => localStorage.getItem('session_token'));
        }

        await use({ admin, userB, userC });

        await admin.context.close();
        await userB.context.close();
        await userC.context.close();
    },
});

export { expect } from '@playwright/test';

// ─── Exported Helpers ──────────────────────────────────────────────────

/**
 * Clear all browser storage: localStorage, sessionStorage, and IndexedDB.
 * The virtual authenticator credentials (CDP-level) are NOT affected.
 */
export async function clearAllStorage(page) {
    await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            for (const db of dbs) {
                indexedDB.deleteDatabase(db.name);
            }
        }
    });
}

/**
 * Register a brand-new user through the complete UI flow:
 *   register.html → enroll-passkey.html → (login auto or pending)
 *
 * Returns { page, context, client, authenticatorId, username, passphrase, sessionToken?, approvalCode? }
 */
export async function registerNewUser(browser, baseURL) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // Set up virtual authenticator
    const client = await context.newCDPSession(page);
    await client.send('WebAuthn.enable');
    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });

    // Username must be 4-15 chars: [a-zA-Z0-9_]
    const id = (++userCounter).toString(36);
    const ts = (Date.now() % 100000).toString(36);
    const username = `u${ts}${id}`.slice(0, 15);
    const passphrase = generatePassphrase();

    // Navigate to register page
    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');

    // Fill registration form
    await page.locator('#register-username').fill(username);
    await page.locator('#recovery-passphrase').fill(passphrase);
    await page.locator('#recovery-passphrase-confirm').fill(passphrase);

    // Submit — the form POSTs to /api/auth/register which redirects to enroll-passkey.html
    await page.locator('#register-submit-button').click();

    // Wait for enroll-passkey page
    await page.waitForURL('**/enroll-passkey.html**');
    await expect(page.locator('#enroll-username')).toHaveText(username);

    // Click "Enroll Passkey" — virtual authenticator handles the WebAuthn ceremony
    await page.locator('#enroll-passkey-button').click();

    // Two outcomes: auto-approved (first user) or pending approval
    // Wait for either redirect to app.html OR the approval code to appear
    const approved = await Promise.race([
        page.waitForURL('**/app.html**', { timeout: 15_000 }).then(() => true),
        page.locator('.approval-code').waitFor({ timeout: 15_000 }).then(() => false),
    ]);

    let sessionToken = null;
    let approvalCode = null;

    if (approved) {
        // First user: auto-approved and logged in
        sessionToken = await page.evaluate(() => localStorage.getItem('session_token'));
    } else {
        // Subsequent user: pending — extract approval code
        approvalCode = await page.locator('.approval-code .code').textContent();
    }

    return { page, context, client, authenticatorId, username, passphrase, sessionToken, approvalCode };
}

/**
 * Poll a URL until it responds (or timeout).
 */
async function waitForServer(baseURL, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await fetch(`${baseURL}/api/server`);
            if (resp.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server at ${baseURL} did not start within ${timeoutMs}ms`);
}
