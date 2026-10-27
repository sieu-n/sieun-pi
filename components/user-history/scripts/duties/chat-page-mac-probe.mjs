// Runs on the owner's Mac, sent over `ssh mac` on stdin by chat-page-mac.ts, which puts its config where CONFIG stands. It times the box's chat
// page in a headless Chromium (playwright-core from the Mac's sieun-pi checkout), never a visible window (c103), and prints one JSON line.
// Each cold load uses a new browser context, so nothing is cached. Every request other than GET is aborted, so opening chats never marks
// the owner's chats read or sends anything.
import { createRequire } from "node:module";
import { homedir, loadavg } from "node:os";

const config = CONFIG;
setTimeout(() => { process.stdout.write(JSON.stringify({ error: `the Mac probe ran past ${config.budgetMs} ms` }) + "\n"); process.exit(2); }, config.budgetMs).unref();
const require = createRequire(`${homedir()}/${config.checkout}/skills/aside-browser/box/package.json`);
const { chromium } = require("playwright-core");

// __firstFrames lists the page's finished first-frame prefetches (Resource Timing), so a switch can say whether its thread was primed.
const SHOWN = `(() => {
  performance.setResourceTimingBufferSize(10000);
  window.__firstFrames = () => performance.getEntriesByType("resource").filter(entry => /\\/api\\/threads\\/[^/]+\\/first-frame$/.test(new URL(entry.name).pathname))
    .map(entry => ({ id: decodeURIComponent(new URL(entry.name).pathname.split("/").at(-2)), start: entry.startTime, sent: entry.requestStart, firstByte: entry.responseStart, end: entry.responseEnd }));
  const look = () => {
    if (window.__shownAt === undefined && document.querySelector(".main .column .line")) {
      window.__shownAt = -1;
      requestAnimationFrame(() => { window.__shownAt = performance.now(); });
    }
  };
  new MutationObserver(look).observe(document, { childList: true, subtree: true });
})();`;

async function context(browser) {
  const made = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await made.route("**/*", route => route.request().method() === "GET" ? route.continue() : route.abort());
  await made.addInitScript(SHOWN);
  return made;
}

const read = page => page.evaluate(() => ({
  shown: window.__shownAt > 0 ? window.__shownAt : null,
  banner: document.querySelector(".banner[role=alert]")?.textContent?.trim() ?? null,
}));

async function coldLoad(browser) {
  const made = await context(browser);
  try {
    const page = await made.newPage();
    await page.goto(config.url, { waitUntil: "commit", timeout: config.loadTimeoutMs });
    await page.waitForFunction(() => window.__shownAt > 0, null, { timeout: config.loadTimeoutMs, polling: 50 }).catch(() => {});
    return await read(page);
  } finally { await made.close(); }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
};

/**
 * Whether the clicked thread's first frame had come back before the click, and its request's times from the click (negative is before it):
 * `frame` is null when no first-frame request for it finished by the paint, so the paint waited on the thread feed's snapshot.
 */
function primed(frames, clickAt) {
  if (clickAt === null) return { primed: null, frame: null };
  const before = frames.find(frame => frame.end <= clickAt);
  const own = before ?? frames[0];
  const at = ms => Math.round(ms - clickAt);
  return { primed: Boolean(before), frame: own ? { startMs: at(own.start), sentMs: at(own.sent), firstByteMs: at(own.firstByte), endMs: at(own.end) } : null };
}

async function switches(browser) {
  const made = await context(browser);
  try {
    const page = await made.newPage();
    await page.goto(config.url, { waitUntil: "commit", timeout: config.loadTimeoutMs });
    await page.waitForFunction(n => document.querySelectorAll('[aria-label="Threads"] a[href^="#"]').length >= n, config.switches + 1, { timeout: config.loadTimeoutMs, polling: 100 });
    await page.waitForTimeout(config.settleMs);
    const current = new URL(config.url).hash.slice(1);
    const ids = (await page.evaluate(() => [...document.querySelectorAll('[aria-label="Threads"] a[href^="#"]')].map(a => a.getAttribute("href").slice(1))))
      .filter((id, index, all) => id && id !== current && all.indexOf(id) === index).slice(0, config.switches);
    const settled = await page.evaluate(() => window.__firstFrames());
    const out = [];
    for (const id of ids) {
      await page.locator(`[aria-label="Threads"] a[href="#${id}"]`).first().click({ timeout: 5000 });
      const ms = await page.waitForFunction(id => performance.getEntriesByName("thread-paint:" + id, "measure")[0]?.duration, id, { timeout: config.switchTimeoutMs, polling: 20 })
        .then(handle => handle.jsonValue(), () => null);
      const seen = await page.evaluate(id => ({
        lines: document.querySelectorAll(".main .column .line").length,
        clickAt: performance.getEntriesByName("thread-switch:" + id, "mark")[0]?.startTime ?? null,
        frames: window.__firstFrames().filter(frame => frame.id === id),
      }), id);
      out.push({ id, ms, lines: seen.lines, ...primed(seen.frames, seen.clickAt) });
      await page.waitForTimeout(config.gapMs);
    }
    return { switches: out, banner: (await read(page)).banner, settle: { frames: settled.length, medianMs: median(settled.map(frame => frame.end - frame.start)) } };
  } finally { await made.close(); }
}

const started = Date.now();
// CHAT_PAGE_MAC_PROBE marks this browser as the one Mac browser d7's mac_test_browsers leaves out (src/worker-footprint.py `test_browsers`).
const browser = await chromium.launch({ headless: true, env: { ...process.env, CHAT_PAGE_MAC_PROBE: "1" } });
try {
  const loads = [];
  for (let index = 0; index < config.loads; index++) loads.push(await coldLoad(browser).catch(error => ({ error: String(error.message ?? error).slice(0, 300) })));
  const tabs = await switches(browser).catch(error => ({ error: String(error.message ?? error).slice(0, 300) }));
  process.stdout.write(JSON.stringify({ loads, tabs, load: loadavg()[0], ms: Date.now() - started }) + "\n");
} finally { await browser.close(); }
process.exit(0);
