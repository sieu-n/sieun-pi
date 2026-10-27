import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser specs for every page, one folder per builder under test/<area>.
 * The web dev build runs in fixture mode on 5187 and proxies /api to the chat server's fixture on 5186.
 * Run one area with `npx playwright test test/shell`.
 */
const WEB_PORT = Number(process.env.CHAT_WEB_PORT ?? 5187);
const SERVER_URL = process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186";

export default defineConfig({
  testDir: "test",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // Chrome on the box sometimes drops a cold dev-server load with ERR_NETWORK_CHANGED.
  retries: 1,
  workers: process.env.CI ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: join(tmpdir(), "apps-chat-playwright"),
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      // The box's installed Google Chrome, so no Playwright browser download is needed.
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: "npm run fixture",
      url: `${SERVER_URL}/api/sidebar`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: "web",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { CHAT_SERVER_URL: SERVER_URL },
    },
  ],
});
