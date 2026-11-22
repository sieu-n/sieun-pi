// The browser half of the wake walk (wake-walk.mjs). It opens the walk's test room in Chromium and WebKit side by side, and for each
// probe the host writes (<dir>/probe-<n>.json) it checks the page every 50 ms for the probe's four changes and writes, per browser, when
// each first showed (<dir>/result-<n>-<browser>.json, Date.now() stamps); the room's new name counts once a GET /api/rooms answer holds it. With "freeze" it freezes the Chromium page from the probe until
// the host's back mark (<dir>/back-<n>.json), as a Mac sleep stops the page's timers. The init script of restart-walk-page.mjs records
// every /api/ fetch and every /api/live socket open and close to <dir>/page-<browser>.jsonl.
// Usage: node wake-walk-page.mjs <front url> <dir> <browsers, comma separated> <room> <freeze|awake>
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../package.json", import.meta.url));
const playwright = require("@playwright/test");
const [front, dir, browserList, room, mode] = process.argv.slice(2);
if (!room) throw new Error("usage: node wake-walk-page.mjs <front url> <dir> <browsers> <room> <freeze|awake>");
const GIVE_UP_MS = 90_000;

const instrument = () => {
  window.__walk = [];
  const records = { push: record => window.__walk.push(record) };
  const realFetch = window.fetch.bind(window);
  let seq = 0;
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!url.pathname.startsWith("/api/") || url.pathname === "/api/timings") return realFetch(input, init);
    const record = { kind: "fetch", id: ++seq, m: method, p: url.pathname, start: Date.now() };
    records.push(record);
    return realFetch(input, init).then(
      response => {
        record.end = Date.now();
        record.s = response.status;
        // The room list has no view in a test room (the sidebar leaves test rooms out), so its answer is kept for the room check.
        if (url.pathname === "/api/rooms" && response.ok) void response.clone().text().then(text => { window.__rooms = text; });
        return response;
      },
      error => {
        record.end = Date.now();
        record.s = 0;
        record.err = String(error?.message ?? error);
        throw error;
      },
    );
  };
  const RealSocket = window.WebSocket;
  window.WebSocket = class extends RealSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (!String(url).includes("/api/live")) return;
      records.push({ kind: "ws", event: "connect", at: Date.now() });
      this.addEventListener("open", () => records.push({ kind: "ws", event: "open", at: Date.now() }));
      this.addEventListener("close", () => records.push({ kind: "ws", event: "close", at: Date.now() }));
      this.addEventListener("message", message => {
        const type = String(message.data).match(/^\{"type":"(\w+)"/)?.[1];
        if (type === "hello") records.push({ kind: "ws", event: "hello", at: Date.now() });
      });
    }
  };
};

const sleep = ms => new Promise(done => setTimeout(done, ms));
const readJson = file => JSON.parse(readFileSync(file, "utf8"));

async function walk(name) {
  const out = `${dir}/page-${name}.jsonl`;
  const write = record => appendFileSync(out, `${JSON.stringify(record)}\n`);
  const browser = await playwright[name].launch({ headless: true, ...(name === "chromium" ? { args: ["--ignore-certificate-errors"] } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  if (name === "webkit") {
    // As the walks of the owner's Mac app do: a Mac platform and the Tauri globals of the desktop app.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ ?? { invoke: async () => null, transformCallback: () => 0, metadata: {} };
    });
  }
  await page.addInitScript(instrument);
  page.on("pageerror", error => write({ kind: "pageerror", at: Date.now(), err: String(error.message).slice(0, 300) }));
  const cdp = name === "chromium" && mode === "freeze" ? await context.newCDPSession(page) : null;
  const take = async () => {
    const records = await page.evaluate(() => {
      const done = window.__walk.filter(r => r.kind !== "fetch" || r.end !== undefined);
      window.__walk = window.__walk.filter(r => r.kind === "fetch" && r.end === undefined);
      return done;
    }).catch(() => []);
    for (const record of records) write(record);
  };
  await page.goto(`${front}/#/c/${room}`);
  await page.locator("main").first().waitFor({ timeout: 60_000 });
  // The home agent's board pane, with its plan and duties.
  await page.getByTestId("board-button").click();
  await page.getByTestId("board-pane").getByText("wake walk first step").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${dir}/ready-${name}.png` });
  writeFileSync(`${dir}/ready-${name}`, String(Date.now()));
  for (let n = 1; !existsSync(`${dir}/stop`); n++) {
    while (!existsSync(`${dir}/probe-${n}.json`) && !existsSync(`${dir}/stop`)) {
      await take();
      await sleep(200);
    }
    if (existsSync(`${dir}/stop`)) break;
    const { markers } = readJson(`${dir}/probe-${n}.json`);
    const seen = {};
    let frozen = false;
    if (cdp) {
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      frozen = true;
      write({ kind: "frozen", at: Date.now(), n });
    }
    let backAt;
    for (;;) {
      if (backAt === undefined && existsSync(`${dir}/back-${n}.json`)) backAt = readJson(`${dir}/back-${n}.json`).backAt;
      if (frozen && backAt !== undefined) {
        await cdp.send("Page.setWebLifecycleState", { state: "active" });
        frozen = false;
        write({ kind: "active", at: Date.now(), n });
      }
      if (!frozen) {
        const shown = await page.evaluate(list => list.map(([key, text]) => (key === "room" ? (window.__rooms ?? "") : document.body.textContent).includes(text)), Object.entries(markers)).catch(() => []);
        const at = Date.now();
        Object.keys(markers).forEach((key, i) => { if (shown[i] && seen[key] === undefined) seen[key] = at; });
      }
      if (backAt !== undefined && (Object.keys(seen).length === Object.keys(markers).length || Date.now() > backAt + GIVE_UP_MS)) break;
      await sleep(50);
    }
    await page.screenshot({ path: `${dir}/probe-${n}-${name}.png` }).catch(() => undefined);
    writeFileSync(`${dir}/result-${n}-${name}.json`, JSON.stringify({ seen, backAt }));
    await take();
  }
  await take();
  await browser.close();
  writeFileSync(`${dir}/done-${name}`, String(Date.now()));
}

await Promise.all(browserList.split(",").map(name => walk(name).catch(error => {
  appendFileSync(`${dir}/page-${name}.jsonl`, `${JSON.stringify({ kind: "fatal", at: Date.now(), err: String(error.stack ?? error).slice(0, 1000) })}\n`);
  writeFileSync(`${dir}/done-${name}`, String(Date.now()));
})));
