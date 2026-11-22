// The browser half of the restart walk (restart-walk.mjs). It opens the chat page in Chromium and WebKit side by side and, until
// <dir>/stop appears, fires the owner's call mix in a loop through the page's own code: it switches between two test channels (room
// header, items and the home agent's board, duties, check-in and agents in the side pane), opens Later and Cmd K now and then, and types
// a send into the first test channel every few steps. The page keeps its live socket open the whole time.
// An init script records every /api/ fetch the page makes (start, end, status or error) and every /api/live socket open and close, with
// Date.now() stamps, so the host can line them up with its release times. Each browser writes <dir>/page-<browser>.jsonl, a ready mark
// once the first room shows, and a done mark at the end.
// Usage: node restart-walk-page.mjs <front url> <dir> <browsers, comma separated> <room A> <room B>
import { createRequire } from "node:module";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../package.json", import.meta.url));
const playwright = require("@playwright/test");
const [front, dir, browserList, roomA, roomB] = process.argv.slice(2);
if (!roomB) throw new Error("usage: node restart-walk-page.mjs <front url> <dir> <browsers> <room A> <room B>");

const instrument = () => {
  window.__walk = [];
  // take() swaps the array, so each record goes to the one there now.
  const records = { push: record => window.__walk.push(record) };
  const realFetch = window.fetch.bind(window);
  let seq = 0;
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const record = { kind: "fetch", id: ++seq, m: method, p: url.pathname, start: Date.now() };
    if (url.pathname.endsWith("/send") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        Object.assign(record, { text: body.text, requestId: body.requestId });
      } catch {}
    }
    records.push(record);
    return realFetch(input, init).then(
      response => {
        record.end = Date.now();
        record.s = response.status;
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
  // Main-thread gaps of 50 ms or more, from a 10 ms timer, so a slow call can be told from a busy page.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - last >= 50) records.push({ kind: "stall", at: Date.now(), ms: Math.round(now - last - 10) });
    last = now;
  }, 10);
  // The live client's dead-socket check (web/src/lib/api/live.svelte.ts): each ping it sends, each pong, and each close() the page calls on
  // an open socket (its drop), with when the socket last brought anything (heardAt) and when the ping on its way left (pingAt).
  const RealSocket = window.WebSocket;
  let sockets = 0;
  window.WebSocket = class extends RealSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (!String(url).includes("/api/live")) return;
      this.walkId = ++sockets;
      this.heardAt = null;
      this.pingAt = null;
      const id = this.walkId;
      records.push({ kind: "ws", event: "connect", socket: id, at: Date.now() });
      this.addEventListener("open", () => records.push({ kind: "ws", event: "open", socket: id, at: Date.now() }));
      this.addEventListener("close", () => records.push({ kind: "ws", event: "close", socket: id, at: Date.now() }));
      this.addEventListener("message", message => {
        this.heardAt = Date.now();
        if (String(message.data).startsWith('{"type":"pong"')) {
          records.push({ kind: "ws", event: "pong", socket: id, at: this.heardAt, pingAt: this.pingAt });
          this.pingAt = null;
        }
      });
    }
    send(data) {
      if (this.walkId && String(data).startsWith('{"type":"ping"')) {
        this.pingAt = Date.now();
        records.push({ kind: "ws", event: "ping", socket: this.walkId, at: this.pingAt, heardAt: this.heardAt, readyState: this.readyState });
      }
      return super.send(data);
    }
    close(code, reason) {
      if (this.walkId) records.push({ kind: "ws", event: "drop", socket: this.walkId, at: Date.now(), heardAt: this.heardAt, pingAt: this.pingAt, readyState: this.readyState });
      return super.close(code, reason);
    }
  };
};

const sleep = ms => new Promise(done => setTimeout(done, ms));

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
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) write({ kind: "navigated", at: Date.now(), url: frame.url() }); });
  // Takes the finished fetch records and the socket events; a fetch still running stays in the page until it ends.
  const take = async () => {
    const records = await page.evaluate(() => {
      const done = window.__walk.filter(r => r.kind !== "fetch" || r.end !== undefined);
      window.__walk = window.__walk.filter(r => r.kind === "fetch" && r.end === undefined);
      return done;
    }).catch(() => []);
    for (const record of records) write(record);
  };
  await page.goto(`${front}/#/c/${roomA}`);
  await page.locator("main").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  writeFileSync(`${dir}/ready-${name}`, String(Date.now()));
  const composer = () => page.locator('main [contenteditable="true"], main textarea').last();
  const go = hash => page.evaluate(h => { location.hash = h; }, hash);
  const sends = [];
  for (let step = 0; !existsSync(`${dir}/stop`); step++) {
    const action = step % 10 === 9 ? "cmdk" : step % 10 === 4 ? "later" : step % 2 ? "roomB" : "roomA";
    try {
      if (action === "roomA") await go(`#/c/${roomA}`);
      else if (action === "roomB") await go(`#/c/${roomB}`);
      else if (action === "later") await go("#/c/later");
      else {
        await page.keyboard.press(name === "webkit" ? "Meta+k" : "Control+k");
        await page.waitForTimeout(800);
        await page.keyboard.press("Escape");
      }
      if (action === "roomA" && step % 6 === 0) {
        // WebKit can still show room B for a moment after the hash change, and a send typed then lands in room B.
        await page.waitForURL(`**/#/c/${roomA}`, { timeout: 3000 });
        await page.waitForTimeout(800);
        const text = `restart walk ${name} send ${sends.length + 1} ${Date.now()}`;
        // fill, not type: WebKit dropped typed letters while the room re-rendered (a baseline post stored as "9222").
        await composer().fill(text, { timeout: 3000 });
        await composer().press("Enter");
        sends.push(text);
        write({ kind: "send", at: Date.now(), text });
      }
    } catch (error) {
      write({ kind: "step-error", at: Date.now(), action, err: String(error.message).split("\n")[0].slice(0, 200) });
    }
    write({ kind: "step", at: Date.now(), action });
    await take();
    await sleep(900);
  }
  await go(`#/c/${roomA}`).catch(() => undefined);
  await page.waitForTimeout(5000);
  await take();
  const notDelivered = await page.locator("main").getByText("Not delivered").count().catch(() => -1);
  write({ kind: "end", at: Date.now(), sends: sends.length, notDelivered });
  await browser.close();
  writeFileSync(`${dir}/done-${name}`, String(Date.now()));
}

await Promise.all(browserList.split(",").map(name => walk(name).catch(error => {
  appendFileSync(`${dir}/page-${name}.jsonl`, `${JSON.stringify({ kind: "fatal", at: Date.now(), err: String(error.stack ?? error).slice(0, 1000) })}\n`);
  writeFileSync(`${dir}/done-${name}`, String(Date.now()));
})));
