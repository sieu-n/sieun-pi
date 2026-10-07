import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BOOT_SLACK_SECONDS, LoginWindow, parseBootTime, readBootTime } from "../src/chat-login-window.ts";
import type { Runner } from "../src/chat-remote.ts";

const URL_ = "http://127.0.0.1:5182/cap/";
const APP = "/Users/me/Applications/Chrome Apps.localized/Prime Agent chat.app";

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "chat-login-window-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { boot: 1_791_358_485.354 as number | null, app: APP as string | null, keepRunning: true };
  const opened: string[] = [];
  const lines: string[] = [];
  const saved: boolean[] = [];
  const markerPath = join(dir, "login-window.json");
  const make = (enabled = true) => new LoginWindow({ url: URL_, markerPath, enabled, platform: "darwin", save: async value => { saved.push(value); },
    startsAtLogin: () => state.keepRunning, bootTime: async () => state.boot, findApp: async url => url === URL_ ? state.app : null,
    open: async app => { opened.push(app); }, log: line => { lines.push(line); }, now: () => new Date("2026-10-07T07:35:00Z") });
  return { dir, state, opened, lines, saved, markerPath, make };
}

test("kern.boottime parses to seconds, and a sysctl failure is no boot time", async () => {
  assert.equal(parseBootTime("{ sec = 1791358485, usec = 354826 } Wed Oct  7 16:34:45 2026\n"), 1791358485.355);
  assert.equal(parseBootTime("garbage"), null);
  const run = (code: number, stdout: string): Runner => async (file, args) => {
    assert.deepEqual([file, args], ["/usr/sbin/sysctl", ["-n", "kern.boottime"]]);
    return { code, stdout, stderr: "", timedOut: false };
  };
  assert.equal(await readBootTime(run(0, "{ sec = 100, usec = 500000 } Thu Jan  1 09:01:40 1970")), 100.5);
  assert.equal(await readBootTime(run(1, "")), null);
});

test("the first login start of a boot opens the app once; a crash restart, an update restart or chat start in that boot opens nothing", async t => {
  const { state, opened, lines, markerPath, make } = await setup(t);
  assert.equal(await make().atLogin(), "opened");
  assert.deepEqual(opened, [APP]);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), { bootTime: state.boot, at: "2026-10-07T07:35:00.000Z", result: "opened" });
  assert.match(lines.at(-1)!, /opened .*Prime Agent chat\.app/);
  // Every later start in the same boot is a new process with the same marker.
  for (let restart = 0; restart < 3; restart++) assert.equal(await make().atLogin(), "same-boot");
  // A clock step moves kern.boottime a little; that is still the same boot, and the marker follows the new reading.
  state.boot! += 2;
  assert.equal(await make().atLogin(), "same-boot");
  assert.equal(JSON.parse(await readFile(markerPath, "utf8")).bootTime, state.boot);
  assert.deepEqual(opened, [APP], "one window per boot");
});

test("a new boot opens the app again", async t => {
  const { state, opened, make } = await setup(t);
  assert.equal(await make().atLogin(), "opened");
  state.boot! += 3600;
  assert.equal(await make().atLogin(), "opened");
  state.boot! += BOOT_SLACK_SECONDS + 1;
  assert.equal(await make().atLogin(), "opened", "two boots are further apart than the slack");
  assert.equal(opened.length, 3);
});

test("with the switch off nothing opens, and that start still decides for the boot", async t => {
  const { state, opened, lines, make } = await setup(t);
  assert.equal(await make(false).atLogin(), "off");
  assert.match(lines.at(-1)!, /switch is off/);
  assert.equal(await make(true).atLogin(), "same-boot", "turning the switch on later in the boot opens nothing until the next login");
  state.boot! += 3600;
  assert.equal(await make(true).atLogin(), "opened");
  assert.deepEqual(opened, [APP]);
});

test("with no installed app nothing opens, no browser tab either, and one line goes to the log", async t => {
  const { state, opened, lines, make } = await setup(t);
  state.app = null;
  assert.equal(await make().atLogin(), "no-app");
  assert.deepEqual(opened, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /no installed app for this chat, nothing opened/);
  assert.doesNotMatch(lines[0]!, /cap/, "the log line does not carry the capability URL");
  assert.equal(await make().atLogin(), "same-boot");
  assert.equal(lines.length, 1, "a restart in the same boot logs nothing more");
});

test("no boot time, an unreadable marker, a failed open, and other platforms", async t => {
  const { state, opened, lines, markerPath, make } = await setup(t);
  state.boot = null;
  assert.equal(await make().atLogin(), "no-boot-time");
  assert.equal(opened.length, 0);
  state.boot = 500;
  await writeFile(markerPath, "{not json");
  assert.equal(await make().atLogin(), "opened", "a broken marker counts as no marker");
  state.boot = 9000;
  const failing = new LoginWindow({ url: URL_, markerPath, enabled: true, platform: "darwin", save: async () => {}, startsAtLogin: () => true,
    bootTime: async () => state.boot, findApp: async () => APP, open: async () => { throw new Error("LSOpenURLsWithRole() failed"); }, log: line => { lines.push(line); } });
  assert.equal(await failing.atLogin(), "failed");
  assert.match(lines.at(-1)!, /could not open .*LSOpenURLsWithRole/);
  assert.equal(JSON.parse(await readFile(markerPath, "utf8")).result, "failed");
  assert.equal(await make().atLogin(), "same-boot", "a failed open is not tried again in the same boot");
  const linux = new LoginWindow({ url: URL_, markerPath: join(markerPath, "..", "linux.json"), enabled: true, platform: "linux", save: async () => {}, startsAtLogin: () => true,
    bootTime: async () => 1, findApp: async () => APP, open: async app => { opened.push(app); } });
  assert.equal(await linux.atLogin(), "off");
  assert.equal(linux.status().available, false);
});

test("Settings says what happens at the next login in plain words", async t => {
  const { state, saved, make } = await setup(t);
  const window = make();
  assert.deepEqual(await window.refresh(), { available: true, enabled: true, appName: "Prime Agent chat", message: "Opens Prime Agent chat once after each login." });
  state.keepRunning = false;
  assert.match(window.status().message, /Turn on "Keep the chat running" too/);
  state.keepRunning = true;
  state.app = null;
  assert.equal((await window.refresh()).message, "Install the chat as an app from Chrome first (Install page as app). Until then nothing opens at login.");
  const off = await window.setEnabled(false);
  assert.deepEqual(saved, [false]);
  assert.equal(off.enabled, false);
  assert.match(off.message, /^Off\./);
});

test("the app lookup reads the shim a Chromium browser wrote under HOME", { skip: process.platform !== "darwin" }, async t => {
  const { dir, markerPath } = await setup(t);
  const contents = join(dir, "Applications", "Chrome Apps.localized", "Prime Agent chat.app", "Contents");
  await mkdir(contents, { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CrAppModeShortcutURL</key><string>${URL_}</string></dict></plist>\n`);
  const home = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = home; });
  const window = new LoginWindow({ url: URL_, markerPath, enabled: true, platform: "darwin", save: async () => {}, startsAtLogin: () => true });
  assert.equal((await window.refresh()).appName, "Prime Agent chat");
});
