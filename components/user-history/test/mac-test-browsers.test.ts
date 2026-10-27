// Guards d7's Mac test browser count: at 16:35Z on 10-19 frontend bro found a Chrome for Testing on the Mac and had to ask whose it was. It was
// the 'teams green add-on' job's headless Playwright rig in ~/scratch/teams-green, under slack green guy, while the d1 offline walk beside it
// ran its browser on us-metal02 through shot-browser.mjs --run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { testBrowsers } from "../scripts/duties/whole-system.ts";
import { type Footprints, type WatchLine, watchLine } from "../src/mac-usable-watch.ts";

const RIG = "/Users/sieunpark/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless";
const footprints = (browsers: NonNullable<Footprints["test_browsers"]>): Footprints => ({ workers: {}, kernels: [], orphans: [], test_browsers: browsers, swap_used_bytes: null, pressure_level: null, cpu_s: 0 });
const rows = [
  { sessionId: "01a11b0b", sessionName: "slack green guy", lifecycle: "live", activeSessionId: "a" },
  { sessionId: "01a154f4", parentSessionId: "01a11b0b", sessionName: "teams green add-on", lifecycle: "live", activeSessionId: "b" },
];
const macLine = (browsers: NonNullable<Footprints["test_browsers"]>) => watchLine({ now: Date.parse("2026-10-19T16:35:16Z"), rows, footprints: footprints(browsers), queue: null,
  chats: new Set(["01a11b0b"]), title: () => null, cpuMs: 0 });
const boxLine = (mac: ReturnType<typeof macLine>): WatchLine => ({ at: "2026-10-19T16:35:30Z", host: "us-metal02", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0,
  queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, ...mac.testBrowsers ? { testBrowsers: mac.testBrowsers } : {} }] });

test("a job's Chrome for Testing on the Mac is flagged with the chat and job that started it", () => {
  const mac = macLine([{ pid: 65145, bytes: 7e7, started: Date.parse("2026-10-19T16:31:08Z") / 1000, command: RIG, root: "01a11b0b", session: "01a154f4" }]);
  assert.deepEqual(mac.testBrowsers, [{ pid: 65145, started: Date.parse("2026-10-19T16:31:08Z") / 1000, root: "01a11b0b", tree: "slack green guy", session: "01a154f4", command: RIG }]);
  const found = testBrowsers(boxLine(mac));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.root, "01a11b0b");
  assert.match(found[0]!.text, /^mac: Chrome for Testing pid 65145 since 16:31Z, started by slack green guy session 01a154f4; agents browse only through Aside \(c177\)$/);
});

test("a browser whose env names no session reads as a duty or ssh command", () => {
  const mac = macLine([{ pid: 2021, bytes: 1e7, started: null, command: "/Users/sieunpark/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell", root: "", session: "" }]);
  const found = testBrowsers(boxLine(mac));
  assert.match(found[0]!.text, /^mac: chrome-headless-shell pid 2021, started by no agent session its env names \(a duty or an ssh command\)/);
  assert.equal(found[0]!.root, "");
});

test("a Mac with no test browser writes none and flags none", () => {
  const mac = macLine([]);
  assert.equal(mac.testBrowsers, undefined);
  assert.deepEqual(testBrowsers(boxLine(mac)), []);
});
