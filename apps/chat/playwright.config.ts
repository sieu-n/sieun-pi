import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { liveRefusal } from "./test/live-guard.ts";

/**
 * Browser specs for every page, one folder per builder under test/<area>.
 * A run builds the web client once into its own folder and the chat server's fixture on 5186 serves it with --web-dir, as a release does,
 * so another session's save under web/ cannot reload the page mid-run. CHAT_WEB_DEV=1 runs the vite dev server on CHAT_WEB_PORT (5187)
 * instead, which proxies /api to the fixture and reloads on every save.
 * Run one area with `npx playwright test test/shell`. CHAT_SERVER_URL (and CHAT_WEB_PORT with CHAT_WEB_DEV) moves the run, so two runs on one
 * box use their own fixture: `CHAT_SERVER_URL=http://127.0.0.1:5690 npx playwright test test/dm`.
 */
const DEV = process.env.CHAT_WEB_DEV === "1";
const SERVER_URL = process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186";
const SERVER_PORT = Number(new URL(SERVER_URL).port || 80);
const DEV_PORT = Number(process.env.CHAT_WEB_PORT ?? 5187);
const refusal = liveRefusal(SERVER_URL) ?? liveRefusal(`http://127.0.0.1:${DEV_PORT}`);
if (refusal) throw new Error(`Refusing to run the specs: ${refusal}`);
/**
 * The specs that set the owner's status, away, notification setting or recent searches, which live on the one fixture server
 * (server/owner-settings.ts). They run one at a time, so one spec's "Off" or pause never lands in another's notification check.
 */
const OWNER_SETTINGS_SPECS = ["**/shell/profile-menu.spec.ts", "**/shell/settings-pages.spec.ts", "**/shell/notifications.spec.ts", "**/shell/owner-settings-sync.spec.ts", "**/search/recent-searches.spec.ts"];
/**
 * Each run writes its traces to its own folder, because Playwright empties its output folder when a run starts and two runs that shared one
 * deleted each other's artifacts. The workers read the main process's pick from the environment. The name stays short, as a long TMPDIR
 * already pushes Chrome's socket path past its limit.
 */
process.env.CHAT_PW_OUTPUT ??= join(tmpdir(), `acpw-${randomBytes(3).toString("hex")}`);
/** The run's web build, beside its output folder, which Playwright empties when the run starts. */
const WEB_DIR = `${process.env.CHAT_PW_OUTPUT}-web`;
/**
 * A run started from a systemd unit hands the fixture servers its INVOCATION_ID, and their duty prechecks would start as transient units of
 * the box (server/duty-run.ts `launchPrecheck`). Without it they start as detached process groups, as for any server outside systemd.
 */
delete process.env.INVOCATION_ID;

/**
 * The specs that import the client's modules by their /src path, which only the vite dev server serves. In a built run they use a dev server
 * that watches no file (vite.config.ts CHAT_WEB_NO_WATCH), so a save under web/ reloads none of their pages either.
 */
const SOURCE_SPECS = [
  "**/channel/restart-ride-out.spec.ts", "**/channel/read-ahead-lane.spec.ts", "**/channel/room-directory.spec.ts", "**/channel/kept-rooms-full.spec.ts",
  "**/channel/open-at-once.spec.ts", "**/channel/write-refetch.spec.ts", "**/search/own-connection.spec.ts",
];
// The box's installed Google Chrome, so no Playwright browser download is needed.
const CHROME = { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } };
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;

export default defineConfig({
  testDir: "test",
  testMatch: "**/*.spec.ts",
  globalSetup: "./test/global-setup.ts",
  fullyParallel: true,
  // Chrome on the box sometimes drops a cold dev-server load with ERR_NETWORK_CHANGED.
  retries: 1,
  workers: process.env.CI ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: process.env.CHAT_PW_OUTPUT,
  use: {
    baseURL: DEV ? DEV_URL : `http://127.0.0.1:${SERVER_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chrome", use: CHROME, testIgnore: DEV ? OWNER_SETTINGS_SPECS : [...OWNER_SETTINGS_SPECS, ...SOURCE_SPECS] },
    { name: "chrome-owner-settings", use: CHROME, testMatch: OWNER_SETTINGS_SPECS, workers: 1 },
    ...(DEV ? [] : [{ name: "chrome-source", use: { ...CHROME, baseURL: DEV_URL }, testMatch: SOURCE_SPECS }]),
  ],
  webServer: [
    DEV
      ? {
        command: `node --import tsx server/main.ts --fixture --port ${SERVER_PORT}`,
        url: `${SERVER_URL}/api/sidebar`,
        reuseExistingServer: true,
        timeout: 60_000,
      }
      : {
        // A server already on the port serves some other build, so the run refuses it rather than test that build.
        command: `cd web && npx vite build --outDir ${WEB_DIR} --emptyOutDir --logLevel warn && cd .. && exec node --import tsx server/main.ts --fixture --port ${SERVER_PORT} --web-dir ${WEB_DIR}`,
        url: `${SERVER_URL}/api/sidebar`,
        reuseExistingServer: false,
        // The build and the server's start took 27 s at load 20 on 11-23, and the old dev-server start had 60 s.
        timeout: 120_000,
      },
    {
      command: `npx vite --host 127.0.0.1 --port ${DEV_PORT} --strictPort`,
      cwd: "web",
      url: DEV_URL,
      reuseExistingServer: DEV,
      timeout: 60_000,
      env: { CHAT_SERVER_URL: SERVER_URL, ...(DEV ? {} : { CHAT_WEB_NO_WATCH: "1" }) },
    },
  ],
});
