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
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Backend source lives in the worktree, but the venv may be in the main repo.
const BACKEND_DIR = resolve(process.cwd(), '..', 'backend');

// Timing instrumentation — set SKRIB_TIMING=1 to enable.
// Prints a table at the end of each test and forwards backend stdout/stderr.
const TIMING = !!process.env.SKRIB_TIMING;
const TIMING_START = Date.now();
function tmark(label, bag) {
    const now = Date.now();
    const total = now - TIMING_START;
    const delta = bag && bag._last ? (now - bag._last) : 0;
    if (bag) {
        bag._last = now;
        bag.marks.push({ label, total, delta });
    }
    if (TIMING) {
        process.stderr.write(`[TIMING:fixture] +${String(total).padStart(6)}ms  (Δ${String(delta).padStart(6)}ms)  ${label}\n`);
    }
}
function printTimingReport(bag) {
    if (!TIMING) return;
    process.stderr.write('\n=== Startup timing report ===\n');
    for (const m of bag.marks) {
        process.stderr.write(`  +${String(m.total).padStart(6)}ms  (Δ${String(m.delta).padStart(6)}ms)  ${m.label}\n`);
    }
    process.stderr.write('=============================\n\n');
}

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
 * Spawn all out-of-process plugin processes, connecting them to the given bus.
 * Returns an array of child processes.
 */
function startPlugins(backendDir, busPort, dataDir) {
    const pluginsDir = join(backendDir, 'plugins');
    const procs = [];
    for (const dir of readdirSync(pluginsDir).filter(d => d.startsWith('four43.'))) {
        const mainPy = join(pluginsDir, dir, '__main__.py');
        if (!existsSync(mainPy)) continue;
        const p = spawn(VENV_PYTHON, [mainPy], {
            env: {
                ...process.env,
                SKRIB_BUS_URL: `ws://127.0.0.1:${busPort}`,
                SKRIB_DATA_DIR: dataDir,
                PYTHONPATH: backendDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (TIMING) {
            const tag = `plugin:${dir}`;
            p.stdout.on('data', d => process.stderr.write(`[${tag} stdout] ${d}`));
            p.stderr.on('data', d => process.stderr.write(`[${tag} stderr] ${d}`));
        } else {
            p.stdout.resume();
            p.stderr.resume();
        }
        procs.push(p);
    }
    return procs;
}

/**
 * Spawn an isolated backend (uvicorn) with a fresh SQLite DB per test.
 * Uses OS-assigned free ports to avoid conflicts between concurrent tests.
 *
 * Plugin processes are NOT started automatically — they're expensive (7
 * Python processes each) and most tests don't need them.  Fixtures that
 * need plugins call `_backend.startPlugins()` which lazily spawns them.
 */
export const test = base.extend({

    // ---------- test-scoped: fresh backend + empty DB per test ----------
    _backend: [async ({}, use) => {
        const timings = { _last: Date.now(), marks: [] };
        tmark('test start', timings);

        const port = await getFreePort();
        const busPort = await getFreePort();
        const dataDir = mkdtempSync(join(tmpdir(), 'skrib-e2e-'));
        tmark('ports & tempdir ready', timings);

        const proc = spawn(VENV_PYTHON, ['-m', 'uvicorn', 'skrib.main:app', '--host', '0.0.0.0', '--port', String(port)], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                SKRIB_DATA_DIR: dataDir,
                SKRIB_RP_ID: 'localhost',
                SKRIB_PLUGIN_BUS_PORT: String(busPort),
                PYTHONPATH: BACKEND_DIR,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        tmark('uvicorn spawned', timings);

        if (TIMING) {
            proc.stdout.on('data', d => process.stderr.write(`[backend stdout] ${d}`));
            proc.stderr.on('data', d => process.stderr.write(`[backend stderr] ${d}`));
        } else {
            // Drain stdout/stderr so pipe buffers don't fill up and block uvicorn
            proc.stdout.resume();
            proc.stderr.resume();
        }

        // Wait for the server to be ready (bus starts during the startup event)
        const baseURL = `http://localhost:${port}`;
        await waitForServer(baseURL, 15_000);
        tmark('backend HTTP ready', timings);

        // Lazy plugin process management — only started when a fixture needs them
        let pluginProcs = null;
        const ensurePlugins = () => {
            if (!pluginProcs) {
                tmark('startPlugins() called', timings);
                pluginProcs = startPlugins(BACKEND_DIR, busPort, dataDir);
                tmark('plugin procs spawned', timings);
            }
        };

        await use({ port, busPort, baseURL, dataDir, proc, ensurePlugins, timings });
        tmark('test finished — tearing down', timings);
        printTimingReport(timings);

        // Teardown: kill plugins (if started), then server, then remove temp data
        if (pluginProcs) {
            for (const p of pluginProcs) p.kill('SIGTERM');
        }
        proc.kill('SIGTERM');
        const exited = await Promise.race([
            new Promise(resolve => proc.on('exit', resolve)).then(() => true),
            new Promise(resolve => setTimeout(resolve, 5_000)).then(() => false),
        ]);
        if (!exited) proc.kill('SIGKILL');
        if (pluginProcs) {
            for (const p of pluginProcs) {
                try { p.kill('SIGKILL'); } catch {}
            }
        }
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
    twoUsers: async ({ _backend, browser, baseURL }, use) => {
        const t = _backend.timings;
        // Start plugins early so they connect to the bus while admin registers
        _backend.ensurePlugins();

        // Register first user (auto-approved as admin)
        const admin = await registerNewUser(browser, baseURL);
        tmark('admin registered', t);

        // Approve plugins (should be fast — they've been connecting in parallel),
        // then reload so the frontend picks up the now-enabled plugin scripts
        await approveAllPlugins(baseURL, admin.sessionToken);
        tmark('plugins approved + chat room type ready', t);
        await admin.page.reload();
        await admin.page.waitForLoadState('networkidle');
        tmark('admin page reloaded', t);

        // Register second user (will be pending)
        const user = await registerNewUser(browser, baseURL);
        tmark('second user registered', t);

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
        tmark('second user approved — fixture ready', t);

        await use({ admin, user });

        await admin.context.close();
        await user.context.close();
    },

    // ---------- Three registered, approved, and logged-in users ----------
    threeUsers: async ({ _backend, browser, baseURL }, use) => {
        // Start plugins early so they connect to the bus while admin registers
        _backend.ensurePlugins();

        // Register User A (auto-approved admin) — lands on app.html
        const admin = await registerNewUser(browser, baseURL);

        // Approve plugins (should be fast — they've been connecting in parallel),
        // then reload so the frontend picks up the now-enabled plugin scripts
        await approveAllPlugins(baseURL, admin.sessionToken);
        await admin.page.reload();
        await admin.page.waitForLoadState('networkidle');

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
 * Approve all pending plugins via the admin API, then wait for room types
 * (specifically the "chat" room type) to be registered on the bus.
 *
 * This exercises the real approval flow: plugins connect → pending → admin
 * approves → secret generated → plugins activate → register room types.
 *
 * @param {string} baseURL  - Backend base URL
 * @param {string} sessionToken - Session token for an admin user
 * @param {number} [timeoutMs=15000] - Max time to wait
 */
export async function approveAllPlugins(baseURL, sessionToken, timeoutMs = 15_000) {
    const headers = {
        'Authorization': `Bearer ${sessionToken}`,
    };
    const start = Date.now();

    // Poll: approve any pending plugins, then check if chat room type is ready
    while (Date.now() - start < timeoutMs) {
        // Approve any pending plugins
        try {
            const pendingResp = await fetch(`${baseURL}/api/admin/plugins/pending`, { headers });
            if (pendingResp.ok) {
                const pending = await pendingResp.json();
                for (const plugin of pending) {
                    await fetch(
                        `${baseURL}/api/admin/plugins/${encodeURIComponent(plugin.plugin_id)}/approve`,
                        { method: 'POST', headers },
                    );
                }
            }
        } catch {}

        // Check if the chat room type is registered (plugins are active)
        try {
            const pluginsResp = await fetch(`${baseURL}/api/plugins`);
            if (pluginsResp.ok) {
                const plugins = await pluginsResp.json();
                const hasChatRoom = plugins.some(p => p.room_types?.includes('chat'));
                if (hasChatRoom) return;
            }
        } catch {}

        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Plugins did not register room types within ${timeoutMs}ms`);
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
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`Server at ${baseURL} did not start within ${timeoutMs}ms`);
}
