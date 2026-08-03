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
 * Discover bundled plugin directories — anything under backend/plugins/ with
 * a __main__.py and a manifest.json. Returns [{ id, dir }].
 */
function discoverBundledPlugins(backendDir) {
    const pluginsDir = join(backendDir, 'plugins');
    const out = [];
    for (const name of readdirSync(pluginsDir).filter(d => d.startsWith('four43.'))) {
        const dir = join(pluginsDir, name);
        if (existsSync(join(dir, '__main__.py')) && existsSync(join(dir, 'manifest.json'))) {
            out.push({ id: name, dir });
        }
    }
    return out;
}

/**
 * Spawn all bundled plugin processes, connecting them to the given bus.
 *
 * Each child captures stdout/stderr into a per-process buffer that we surface
 * if the process exits prematurely or if the readiness wait times out — so a
 * crashing plugin shows its traceback instead of a cryptic 15-second timeout.
 *
 * Returns { procs, failures } where failures is a Promise that resolves to
 * { id, code, stderr } the moment any plugin exits, or never resolves if all
 * stay alive.
 */
function startPlugins(backendDir, busPort, dataDir) {
    const procs = [];
    const earlyExits = [];
    for (const { id, dir } of discoverBundledPlugins(backendDir)) {
        const mainPy = join(dir, '__main__.py');
        const buf = { id, stdout: '', stderr: '' };
        const p = spawn(VENV_PYTHON, [mainPy], {
            env: {
                ...process.env,
                SKRIB_BUS_URL: `ws://127.0.0.1:${busPort}`,
                SKRIB_DATA_DIR: dataDir,
                PYTHONPATH: backendDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        p.stdout.setEncoding('utf8');
        p.stderr.setEncoding('utf8');
        p.stdout.on('data', d => {
            buf.stdout += d;
            if (TIMING) process.stderr.write(`[plugin:${id} stdout] ${d}`);
        });
        p.stderr.on('data', d => {
            buf.stderr += d;
            if (TIMING) process.stderr.write(`[plugin:${id} stderr] ${d}`);
        });
        p.skribBuf = buf;
        earlyExits.push(new Promise(resolve => {
            p.on('exit', code => {
                if (code !== null && code !== 0) resolve({ id, code, stderr: buf.stderr });
            });
        }));
        procs.push(p);
    }
    const earlyExit = Promise.race(earlyExits);
    return { procs, earlyExit };
}

/**
 * Wait for every bundled plugin to be connected and registered on the bus.
 *
 * Polls GET /api/plugins until every expected plugin id appears with at
 * least its declared room_types registered. If any plugin process exits
 * before that happens, throws with the captured stderr so the failure is
 * visible.
 */
async function waitForPluginsReady(baseURL, expected, earlyExit, timeoutMs = 20_000) {
    const expectedRoomTypes = {};
    for (const e of expected) {
        if (e.roomTypes && e.roomTypes.length) expectedRoomTypes[e.id] = e.roomTypes;
    }
    const expectedIds = new Set(expected.map(e => e.id));

    const start = Date.now();
    let lastSnapshot = null;
    while (Date.now() - start < timeoutMs) {
        const winner = await Promise.race([
            (async () => {
                try {
                    const resp = await fetch(`${baseURL}/api/plugins`);
                    if (!resp.ok) return null;
                    return { plugins: await resp.json() };
                } catch {
                    return null;
                }
            })(),
            earlyExit.then(failure => ({ failure })),
        ]);

        if (winner?.failure) {
            const { id, code, stderr } = winner.failure;
            throw new Error(
                `Plugin '${id}' exited with code ${code} before becoming ready.\n` +
                `--- stderr ---\n${stderr || '(empty)'}\n--------------`
            );
        }

        if (winner?.plugins) {
            lastSnapshot = winner.plugins;
            const seen = new Set(winner.plugins.map(p => p.id));
            const missing = [...expectedIds].filter(id => !seen.has(id));
            const wrongRoomTypes = Object.entries(expectedRoomTypes).filter(([id, rts]) => {
                const p = winner.plugins.find(x => x.id === id);
                return !p || !rts.every(rt => p.room_types?.includes(rt));
            }).map(([id]) => id);
            if (missing.length === 0 && wrongRoomTypes.length === 0) return winner.plugins;
        }

        await new Promise(r => setTimeout(r, 50));
    }

    const seen = lastSnapshot ? lastSnapshot.map(p => p.id).join(', ') : '(none)';
    throw new Error(
        `Plugins did not become ready within ${timeoutMs}ms.\n` +
        `Expected: ${[...expectedIds].join(', ')}\nSeen on bus: ${seen}`
    );
}

/**
 * Spawn an isolated backend (uvicorn) with a fresh SQLite DB per test.
 * Uses OS-assigned free ports to avoid conflicts between concurrent tests.
 *
 * The backend runs in plugin auto-approve mode (SKRIB_PLUGIN_AUTO_APPROVE=1)
 * so no admin approval is needed — plugins are approved on first hello.
 *
 * Plugin processes are NOT spawned automatically (they're expensive — one
 * Python process per bundled plugin). Fixtures that need plugins call
 * `_backend.ensurePlugins()`, which spawns them and returns a Promise that
 * resolves when *every* bundled plugin is registered on the bus.
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

        // Bundled plugins we expect to register on the bus. The on-disk
        // manifests don't declare `room_types` — that lives in the plugin
        // class — so the fixture pins room-type expectations here. If you add
        // a new bundled plugin that owns a room type, list it here.
        const ROOM_TYPES_BY_ID = {
            'four43.room-type-chat': ['chat'],
            'four43.room-type-todo': ['todo'],
        };
        const bundled = discoverBundledPlugins(BACKEND_DIR).map(({ id }) => ({
            id,
            roomTypes: ROOM_TYPES_BY_ID[id] || [],
        }));

        const proc = spawn(VENV_PYTHON, ['-m', 'uvicorn', 'skrib.main:app', '--host', '0.0.0.0', '--port', String(port)], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                SKRIB_DATA_DIR: dataDir,
                SKRIB_RP_ID: 'localhost',
                SKRIB_PLUGIN_BUS_PORT: String(busPort),
                // E2E tests never need the admin-approval dance — auto-approve
                // every bundled plugin connection so startup is deterministic.
                SKRIB_PLUGIN_AUTO_APPROVE: '1',
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

        // Plugin process management — spawn immediately so they connect to the
        // bus while the test's user-registration UI flow runs. Awaiting
        // ensurePlugins() resolves the moment every plugin is registered;
        // tests that don't touch rooms can skip the await and they'll just be
        // ready by the time anything cares.
        tmark('startPlugins() called', timings);
        const { procs: pluginProcs, earlyExit } = startPlugins(BACKEND_DIR, busPort, dataDir);
        tmark('plugin procs spawned', timings);
        const pluginsReady = waitForPluginsReady(baseURL, bundled, earlyExit).then(plugins => {
            tmark('all plugins ready', timings);
            return plugins;
        });
        // Surface plugin readiness errors instead of leaving an unhandled rejection.
        pluginsReady.catch(err => process.stderr.write(`[plugin readiness] ${err.message}\n`));
        const ensurePlugins = () => pluginsReady;
        const pluginState = { procs: pluginProcs, earlyExit, ready: pluginsReady };

        await use({ port, busPort, baseURL, dataDir, proc, ensurePlugins, bundled, timings });
        tmark('test finished — tearing down', timings);
        printTimingReport(timings);

        // Surface any plugin that died unexpectedly during the test so its
        // stderr appears in the report instead of being silently dropped.
        for (const p of pluginState.procs) {
            if (p.exitCode !== null && p.exitCode !== 0) {
                process.stderr.write(
                    `\n[plugin:${p.skribBuf.id}] exited with code ${p.exitCode} during test\n` +
                    `--- stderr ---\n${p.skribBuf.stderr || '(empty)'}\n--------------\n`
                );
            }
        }
        for (const p of pluginState.procs) p.kill('SIGTERM');
        proc.kill('SIGTERM');
        const exited = await Promise.race([
            new Promise(resolve => proc.on('exit', resolve)).then(() => true),
            new Promise(resolve => setTimeout(resolve, 5_000)).then(() => false),
        ]);
        if (!exited) proc.kill('SIGKILL');
        for (const p of pluginState.procs) {
            try { p.kill('SIGKILL'); } catch {}
        }
        try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }, { scope: 'test', auto: true }],

    // ---------- override baseURL to point at the per-test backend ----------
    baseURL: async ({ _backend }, use) => {
        await use(_backend.baseURL);
    },

    // ---------- Page with a virtual WebAuthn authenticator ----------
    authenticatedPage: async ({ _backend, browser, baseURL }, use) => {
        // Ensure all bundled plugins are connected before any test can try to
        // create a chat room — backend rooms.create rejects unknown room types
        // with 400, so without plugins running the room creation UI silently
        // fails.
        await _backend.ensurePlugins();

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
    // Ensures plugins are running too — every plugin-aware UI test (room
    // creation, message input, reactions, etc.) needs the chat plugin
    // connected and registered before the user reaches app.html.
    registeredUser: async ({ _backend, browser, baseURL }, use) => {
        const pluginsReady = _backend.ensurePlugins();
        const result = await registerNewUser(browser, baseURL);
        await pluginsReady;
        // If the user is logged in (auto-approved admin), reload so the
        // frontend picks up plugin scripts that registered while registration
        // was in flight. Pending users stay on the enroll/pending page.
        if (result.sessionToken) {
            await result.page.reload();
            await result.page.waitForLoadState('networkidle');
        }
        await use(result);
        await result.context.close();
    },

    // ---------- Two registered users: first is admin, second is approved ----------
    twoUsers: async ({ _backend, browser, baseURL }, use) => {
        const t = _backend.timings;
        // Start plugins early so they're connecting in parallel with admin registration
        const pluginsReady = _backend.ensurePlugins();

        // Register first user (auto-approved as admin)
        const admin = await registerNewUser(browser, baseURL);
        tmark('admin registered', t);

        // Wait for every bundled plugin to be on the bus, then reload so the
        // frontend picks up the now-loaded plugin scripts.
        await pluginsReady;
        tmark('all bundled plugins ready', t);
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
        // Start plugins early so they're connecting in parallel with admin registration
        const pluginsReady = _backend.ensurePlugins();

        // Register User A (auto-approved admin) — lands on app.html
        const admin = await registerNewUser(browser, baseURL);

        // Wait for every bundled plugin, then reload so the frontend picks up scripts
        await pluginsReady;
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
