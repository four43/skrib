import { test as base, expect } from '@playwright/test';
import { registerNewUser } from './fixtures.js';

const test = base.extend({
    _backend: [async ({}, use, workerInfo) => {
        const { spawn, execSync } = await import('child_process');
        const { mkdtempSync, rmSync, existsSync } = await import('fs');
        const { tmpdir } = await import('os');
        const { join, resolve } = await import('path');

        const BACKEND_DIR = resolve(process.cwd(), '..', 'backend');
        function findVenvPython() {
            const local = join(BACKEND_DIR, '.venv', 'bin', 'python');
            if (existsSync(local)) return local;
            try {
                const mainRoot = execSync('git worktree list --porcelain', { cwd: BACKEND_DIR, encoding: 'utf8' })
                    .split('\n').find(l => l.startsWith('worktree '))?.replace('worktree ', '');
                if (mainRoot) {
                    const mainVenv = join(mainRoot, 'backend', '.venv', 'bin', 'python');
                    if (existsSync(mainVenv)) return mainVenv;
                }
            } catch {}
            return 'python';
        }

        const port = 8800 + workerInfo.workerIndex;
        const dataDir = mkdtempSync(join(tmpdir(), 'skrib-e2e-'));
        const proc = spawn(findVenvPython(), ['-m', 'uvicorn', 'skrib.main:app', '--host', '0.0.0.0', '--port', String(port)], {
            cwd: BACKEND_DIR,
            env: { ...process.env, SKRIB_DATA_DIR: dataDir, SKRIB_RP_ID: 'localhost', PYTHONPATH: BACKEND_DIR },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const baseURL = `http://localhost:${port}`;
        const start = Date.now();
        while (Date.now() - start < 15000) {
            try { const r = await fetch(`${baseURL}/api/server`); if (r.ok) break; } catch {}
            await new Promise(r => setTimeout(r, 200));
        }

        await use({ port, baseURL, dataDir, proc });
        proc.kill('SIGTERM');
        await new Promise(resolve => proc.on('exit', resolve));
        try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }, { scope: 'test', auto: true }],

    baseURL: async ({ _backend }, use) => { await use(_backend.baseURL); },
});

test('Debug threeUsers fixture steps', async ({ browser, baseURL }) => {
    const admin = await registerNewUser(browser, baseURL);
    console.debug('Admin username:', admin.username);
    console.debug('Admin sessionToken:', !!admin.sessionToken);
    console.debug('Admin approvalCode:', admin.approvalCode);

    console.debug('=== Step 2: Register userB ===');
    const userB = await registerNewUser(browser, baseURL);
    console.debug('UserB username:', userB.username);
    console.debug('UserB sessionToken:', !!userB.sessionToken);
    console.debug('UserB approvalCode:', userB.approvalCode);

    console.debug('=== Step 3: Register userC ===');
    const userC = await registerNewUser(browser, baseURL);
    console.debug('UserC username:', userC.username);
    console.debug('UserC sessionToken:', !!userC.sessionToken);
    console.debug('UserC approvalCode:', userC.approvalCode);

    console.debug('=== Step 4: Approve userB ===');
    const respB = await admin.page.request.patch(
        `${baseURL}/api/users/pending/${encodeURIComponent(userB.approvalCode)}`,
        {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admin.sessionToken}` },
            data: { status: 'approved' },
        }
    );
    console.debug('Approve userB status:', respB.status());
    if (!respB.ok()) {
        console.debug('Approve userB body:', await respB.text());
    }

    console.debug('=== Step 5: Approve userC ===');
    const respC = await admin.page.request.patch(
        `${baseURL}/api/users/pending/${encodeURIComponent(userC.approvalCode)}`,
        {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admin.sessionToken}` },
            data: { status: 'approved' },
        }
    );
    console.debug('Approve userC status:', respC.status());
    if (!respC.ok()) {
        console.debug('Approve userC body:', await respC.text());
    }

    // Clean up
    await admin.context.close();
    await userB.context.close();
    await userC.context.close();
});
