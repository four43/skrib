/**
 * Shared E2E test fixtures for Skrīb.
 *
 * Provides:
 *   - _workerBackend: (worker-scoped) spawns an isolated backend per Playwright
 *     worker with its own temp SQLite database.  The backend serves the built
 *     frontend from frontend/dist/, so no Vite dev server is needed.
 *   - baseURL: overridden to point at the per-worker backend.
 *   - authenticatedPage: a Page with a virtual WebAuthn authenticator attached
 *   - registeredUser: registers a fresh user and returns { page, username }
 */
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Resolve once so path math is unambiguous regardless of cwd.
const FRONTEND_DIR = resolve(import.meta.dirname, '..', '..');
const BACKEND_DIR  = resolve(FRONTEND_DIR, '..', 'backend');
const UVICORN_BIN  = join(BACKEND_DIR, '.venv', 'bin', 'uvicorn');

/** Poll a URL until it responds 2xx, or throw after `timeout` ms. */
async function waitForServer(url, { timeout = 1000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeout}ms`);
}

export const test = base.extend({
  /**
   * Worker-scoped: starts an isolated backend per Playwright worker.
   * The backend serves the Vite-built frontend from frontend/dist/ and the
   * API + WebSocket endpoints — a single origin, no proxy needed.
   */
  _workerBackend: [async ({}, use, workerInfo) => {
    const port = 8800 + workerInfo.workerIndex;
    const dataDir = mkdtempSync(join(tmpdir(), 'skrib-e2e-'));

    const backend = spawn(
      UVICORN_BIN,
      ['skrib.main:app', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: BACKEND_DIR,
        env: {
          ...process.env,
          SKRIB_DATA_DIR: dataDir,
          SKRIB_REGISTRATION_MODE: 'open',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    backend.stderr.on('data', d => process.stderr.write(`[backend:${workerInfo.workerIndex}] ${d}`));

    await waitForServer(`http://127.0.0.1:${port}/api/server`);

    await use({ port, dataDir });

    backend.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }, { scope: 'worker' }],

  /** Override built-in baseURL to point at this worker's backend. */
  baseURL: async ({ _workerBackend }, use) => {
    await use(`http://localhost:${_workerBackend.port}`);
  },

  /**
   * Page with a virtual WebAuthn authenticator (CDP).
   * Authenticator is torn down after the test.
   */
  authenticatedPage: async ({ page }, use) => {
    const client = await page.context().newCDPSession(page);
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

    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await client.send('WebAuthn.disable');
  },

  /**
   * Registers a brand-new user against the running E2E backend.
   * Returns { page, username }.
   *
   * Depends on authenticatedPage so the WebAuthn ceremony succeeds.
   * Uses pressSequentially (project convention: fill() doesn't fire validation events).
   */
  registeredUser: async ({ authenticatedPage: page }, use) => {
    const username = `tu${Math.random().toString(36).slice(2, 9)}`;

    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');

    const input = page.locator('#register-username');
    await input.pressSequentially(username, { delay: 30 });
    await expect(input).not.toHaveClass(/invalid/);

    await page.locator('#recovery-passphrase').fill('This-is-a-valid-test-passphrase-32!');
    await page.locator('#recovery-passphrase-confirm').fill('This-is-a-valid-test-passphrase-32!');
    await page.locator('#register-submit-button').click();

    // Form POST redirects to enroll-passkey page
    await page.waitForURL(/.*enroll-passkey\.html/, { timeout: 5000 });
    await expect(page.locator('#enroll-username')).not.toBeEmpty();
    await page.locator('#enroll-passkey-button').click();

    // First user is auto-approved (open registration mode) -> redirects to chat.
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });

    const sessionToken = await page.evaluate(() => localStorage.getItem('session_token'));
    expect(sessionToken).toBeTruthy();

    await use({ page, username });
  },
});

export { expect };
