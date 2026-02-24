import { defineConfig, devices } from '@playwright/test';

const isE2E = !!process.env.SKRIB_TEST_DATA_DIR;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  projects: [
    {
      name: 'dom',
      testDir: './tests',
      testIgnore: '**/e2e/**',
      timeout: 5000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5173',
      },
    },
    ...(isE2E ? [{
      name: 'e2e',
      testDir: './tests/e2e',
      // Each worker spawns its own backend + Vite via the _workerServers fixture,
      // so no shared webServer or baseURL needed here.
      workers: undefined, // auto — use all available cores
      timeout: 30000,
      use: {
        ...devices['Desktop Chrome'],
      },
    }] : []),
  ],
  // DOM tests use a shared Vite dev server; E2E servers are managed per-worker by fixtures.
  webServer: isE2E
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
      },
});
