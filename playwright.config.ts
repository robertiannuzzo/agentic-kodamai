import { defineConfig } from "@playwright/test";

// Each run starts from an empty database; see the web server command below.
const databasePath = "build/e2e/recruitment.sqlite";

const port = Number(process.env.E2E_PORT ?? 3037);

export default defineConfig({
  testDir: "tests/end-to-end",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Locally, use the installed Chrome; CI installs Playwright's Chromium instead.
    ...(process.env.CI === undefined ? { channel: "chrome" } : {}),
    trace: "retain-on-failure"
  },
  webServer: {
    command: "rm -rf build/e2e && node build/api/apps/api/src/main.js",
    env: { DATABASE_PATH: databasePath, PORT: String(port), HOST: "127.0.0.1" },
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
