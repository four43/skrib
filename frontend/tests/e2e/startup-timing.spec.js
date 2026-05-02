/**
 * Debug test for startup timing.
 *
 * Exercises the full path tests typically spend time waiting on:
 *   backend spawn → uvicorn ready → plugin procs spawn → plugin connect →
 *   admin registers → plugins approved → chat room type registered → ready
 *
 * Run with:
 *   SKRIB_TIMING=1 ./util/test-startup-timing
 *
 * The fixture prints a phase-by-phase timing report at the end. When
 * SKRIB_TIMING=1 is set the backend and plugin processes also emit
 * [TIMING:backend] and [TIMING:plugin:*] lines, which are forwarded to
 * stderr so you can correlate them with the fixture phases.
 *
 * Kept serial (.describe.serial) so timings aren't muddied by parallelism.
 */

import { test, expect } from './fixtures.js';

test.describe.serial('startup timing debug', () => {

    test('full twoUsers path (admin + pending user)', async ({ twoUsers }) => {
        const { admin, user } = twoUsers;
        // A cheap sanity check; what we care about is the timing report
        // printed by the fixture during teardown.
        await expect(admin.page).toHaveURL(/app\.html/);
        expect(user.approvalCode || user.sessionToken).toBeTruthy();
    });

    test('backend-only path (no plugins)', async ({ _backend, baseURL }) => {
        // Plugins are lazy — skipping `ensurePlugins()` isolates backend boot cost.
        const resp = await fetch(`${baseURL}/api/server`);
        expect(resp.ok).toBeTruthy();
    });

});
