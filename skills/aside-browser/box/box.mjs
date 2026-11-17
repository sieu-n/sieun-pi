// Headful Chrome on this host, on its own Xvfb display, with the Aside REPL's globals, so pages that need none of the owner's
// logins render here instead of in his Aside window. aside_browser starts one runner per kernel and talks JSON lines on
// stdin/stdout: {"id", "code"} in, {"id", "out"} or {"id", "error"} out. The runner exits when stdin closes, and its display,
// browser and profile go with it. A kernel on the owner's Mac starts it here over ssh with BOX_LOOPBACK_VIA set (loopback.mjs).
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { hasDisplayServer, startDisplay } from "./display.mjs";
import { cacheShared, pruneShared } from "./http-cache.mjs";
import { holdLeaves } from "./leave.mjs";
import { startLoopbackTunnel } from "./loopback.mjs";

// Chrome's profile lives in a folder named for this runner's pid, because Playwright makes it under os.tmpdir() and a
// SIGKILLed runner cannot remove it. Each start removes the folders of runners that are gone.
const TMP = os.tmpdir();
for (const name of fs.readdirSync(TMP)) {
  const pid = Number(/^aside-box-(\d+)-/.exec(name)?.[1]);
  if (!pid) continue;
  try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") fs.rmSync(path.join(TMP, name), { recursive: true, force: true }); }
}
const profileRoot = fs.mkdtempSync(path.join(TMP, `aside-box-${process.pid}-`));
// The REPL code's relative paths, as in page.screenshot({ path: "shot.png" }) or fs.writeFileSync("x.cpuprofile"), resolve
// against this folder. The runner used to keep the skill's own folder as its cwd, and by 11-18 jobs had left 27 screenshots,
// CPU profiles and websocket dumps there, untracked in the sieun-pi checkout.
const OUT = path.join(os.homedir(), "work", "aside-box");
fs.mkdirSync(OUT, { recursive: true });
process.chdir(OUT);
process.env.TMPDIR = profileRoot;
const cleanup = () => fs.rmSync(profileRoot, { recursive: true, force: true });
pruneShared();

// Agents never run a headless browser (owner c177, 10-27: "NEVER put it back in"), so a host with no Xvfb gets an error, not a headless Chrome.
if (!hasDisplayServer()) {
  process.stderr.write("aside-box: no Xvfb on this host, and the box browser never runs headless (c177); install Xvfb as deploy/linux/README.md (Tools, steps 3 and 4) says\n");
  cleanup();
  process.exit(1);
}
const screen = await startDisplay();
const loopback = process.env.BOX_LOOPBACK_VIA ? await startLoopbackTunnel(process.env.BOX_LOOPBACK_VIA) : null;
const proxy = loopback ? { proxy: loopback.proxy, args: loopback.args } : {};
const chrome = process.env.BOX_CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : chromium.executablePath());
const env = { ...process.env, DISPLAY: screen.display };
// Chromium fails every in-flight request with ERR_NETWORK_CHANGED when a host interface changes address. On us-metal02
// the CI VMs add and drop cig-N taps all day, and on 2026-10-18 a plain launch hit 158 such failures and 2 of 4 loads of
// a Vite page rendered "500 Internal Error", while the wrapper that hides netlink from Chromium hit 0 and 4 of 4 loaded.
// Chrome exits when the runner's end of its debugging pipe closes, so a SIGKILLed runner leaves no browser either.
const browser = await chromium.launch(process.platform === "linux" && process.arch === "x64"
  ? { headless: false, executablePath: new URL("./no-netlink-chromium.py", import.meta.url).pathname, env: { ...env, BOX_CHROMIUM: chrome }, ...proxy }
  : { headless: false, executablePath: chrome, env, ...proxy });
let closing = false;
browser.on("disconnected", () => { screen.close(); loopback?.close(); cleanup(); if (!closing) process.exit(1); });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// A walk that makes its own context, as a clean second user through page.context().browser().newContext(), gets the disk
// cache on its pages too, before their first request. On 11-14 the home report walks' fresh-user contexts asked staging
// /api/img again 634 times for pictures the cache already held, 476 of them from 23:00Z to 00:00Z.
const newContext = browser.newContext.bind(browser);
browser.newContext = async (options) => {
  const ctx = await newContext(options);
  const ready = new WeakMap();
  const share = (p) => {
    if (!ready.has(p)) ready.set(p, cacheShared(ctx, p).catch(() => {}));
    return ready.get(p);
  };
  ctx.on("page", share);
  const newPage = ctx.newPage.bind(ctx);
  ctx.newPage = async () => {
    const p = await newPage();
    await share(p);
    return p;
  };
  return ctx;
};
const ids = new WeakMap();
const cached = new WeakMap();
let next = 1;
const tabs = [];
let page = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targetId = (p) => ids.get(p);
const getTabByTargetId = (id) => tabs.find((p) => targetId(p) === id) || null;

function adopt(p) {
  if (ids.has(p)) return p;
  ids.set(p, `box-${next++}`);
  cached.set(p, cacheShared(context, p).catch(() => {}));
  Object.defineProperty(p, "targetId", { get: () => ids.get(p) });
  const locator = p.locator.bind(p);
  p.locator = (selector, options) => locator(/^e\d+$/.test(selector) ? `aria-ref=${selector}` : selector, options);
  holdLeaves(p);
  p.on("close", () => {
    const i = tabs.indexOf(p);
    if (i >= 0) tabs.splice(i, 1);
    if (page === p) page = tabs[tabs.length - 1] || null;
  });
  tabs.push(p);
  return p;
}
context.on("page", adopt);

async function openTab(url) {
  const p = adopt(await context.newPage());
  await cached.get(p);
  if (url) await p.goto(url, { waitUntil: "load", timeout: 60000 }).catch((e) => { if (!/timeout/i.test(String(e))) throw e; });
  page = p;
  return p;
}
async function closeTab(p) {
  if (p) await p.close();
}
async function listBrowserTabs() {
  return Promise.all(tabs.map(async (p) => ({ targetId: targetId(p), title: await p.title().catch(() => ""), url: p.url(), active: p === page })));
}
async function attachBrowserTab(id) {
  const p = getTabByTargetId(id);
  if (!p) throw new Error(`No open browser tab found for targetId ${id}`);
  page = p;
  return p;
}
async function attachActiveBrowserTab() {
  if (!page) throw new Error("No open box tab");
  return page;
}
async function snapshot(p, opts = {}) {
  const tree = await p._snapshotForAI();
  return { tree: typeof tree === "string" ? tree : tree.full };
}
async function annotatedScreenshot(p) {
  return { base64Image: (await p.screenshot()).toString("base64") };
}

const AsyncFunction = (async () => {}).constructor;

// `with` gives the code live bindings, so `page` changes after `await openTab(url)` inside the same call, as in the Aside REPL.
async function run(code) {
  const lines = [];
  const log = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  const scope = Object.create(null);
  Object.defineProperty(scope, "page", { get: () => page, set: (p) => { page = p; } });
  Object.defineProperty(scope, "tabs", { get: () => tabs });
  Object.assign(scope, { openTab, closeTab, listBrowserTabs, attachBrowserTab, attachActiveBrowserTab, getTabByTargetId,
    snapshot, annotatedScreenshot, sleep, fs, Buffer, console: { log, info: log, warn: log, error: log } });
  await new AsyncFunction("__scope", `with (__scope) {\n${code}\n}`)(scope);
  return lines.join("\n");
}

// The runner exits as soon as stdin closes, even while a command still runs. On 2026-11-03 a box started from a Mac
// kernel stayed up 2.9 h with its Chrome, Xvfb and 13 processes after that kernel and its ssh end were gone: no process
// held the write end of its stdin, but the loop sat in an await that never returned and never read the end. Chrome
// exits on its own when this process's debugging pipe closes.
const rl = createInterface({ input: process.stdin });
rl.on("close", () => { closing = true; screen.close(); loopback?.close(); cleanup(); process.exit(0); });
for await (const line of rl) {
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  try {
    process.stdout.write(JSON.stringify({ id: msg.id, out: await run(msg.code) }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: msg.id, error: String((e && e.stack) || e) }) + "\n");
  }
}
