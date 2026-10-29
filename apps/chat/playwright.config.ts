import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser specs for every page, one folder per builder under test/<area>.
 * The web dev build runs in fixture mode on 5187 and proxies /api to the chat server's fixture on 5186.
 * Run one area with `npx playwright test test/shell`. CHAT_WEB_PORT and CHAT_SERVER_URL move both, so two runs on one box use their own
 * fixture: `CHAT_SERVER_URL=http://127.0.0.1:5690 CHAT_WEB_PORT=5691 npx playwright test test/dm`.
 */
const WEB_PORT = Number(process.env.CHAT_WEB_PORT ?? 5187);
const SERVER_URL = process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186";
const SERVER_PORT = Number(new URL(SERVER_URL).port || 80);

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
      command: `node --import tsx server/main.ts --fixture --port ${SERVER_PORT}`,
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
