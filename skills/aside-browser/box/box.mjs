// Headless Chromium on this host with the Aside REPL's globals, so pages that need none of the owner's logins
// render here instead of in his Aside window. aside_browser starts one runner per kernel and talks JSON lines on
// stdin/stdout: {"id", "code"} in, {"id", "out"} or {"id", "error"} out. The runner exits when stdin closes.
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ids = new WeakMap();
let next = 1;
const tabs = [];
let page = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targetId = (p) => ids.get(p);
const getTabByTargetId = (id) => tabs.find((p) => targetId(p) === id) || null;

function adopt(p) {
  if (ids.has(p)) return p;
  ids.set(p, `box-${next++}`);
  Object.defineProperty(p, "targetId", { get: () => ids.get(p) });
  const locator = p.locator.bind(p);
  p.locator = (selector, options) => locator(/^e\d+$/.test(selector) ? `aria-ref=${selector}` : selector, options);
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

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  try {
    process.stdout.write(JSON.stringify({ id: msg.id, out: await run(msg.code) }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: msg.id, error: String((e && e.stack) || e) }) + "\n");
  }
}
await browser.close();
