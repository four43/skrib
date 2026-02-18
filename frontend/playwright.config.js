import { defineConfig, devices } from '@playwright/test';

const isE2E = !!process.env.SKRIB_TEST_DATA_DIR;

const e2eBackendPort = 8765;
const e2eFrontendPort = 5174;

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
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${e2eFrontendPort}`,
      },
    }] : []),
  ],
  webServer: isE2E
    ? [
        {
          command: `SKRIB_DATA_DIR=${process.env.SKRIB_TEST_DATA_DIR} SKRIB_REGISTRATION_MODE=open .venv/bin/uvicorn skrib.main:app --host 127.0.0.1 --port ${e2eBackendPort}`,
          cwd: '../backend',
          url: `http://127.0.0.1:${e2eBackendPort}/api/server`,
          reuseExistingServer: false,
          timeout: 30000,
        },
        {
          command: `VITE_API_TARGET=http://127.0.0.1:${e2eBackendPort} npx vite --port ${e2eFrontendPort} --strictPort`,
          url: `http://localhost:${e2eFrontendPort}`,
          reuseExistingServer: false,
          timeout: 15000,
        },
      ]
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
      },
});
