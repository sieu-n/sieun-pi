import type { Repl } from "./aside-repl.ts";
import type { BrowserLoad, BrowserOutput, BrowserSwitch } from "./chat-page-mac.ts";

/**
 * The browser half of the Chat page from the Mac duty (chat-page-mac.ts): cold loads and cold tab switches of the box's chat page, timed in
 * background tabs of the owner's Aside on his MacBook Pro over one `aside mcp` (aside-repl.ts). Owner c177, 10-27: "can you remove Headless
 * browser???? NEVER put it back in. we'll always use Aside only." Until then chat-page-mac-probe.mjs ran a headless Chromium on the Mac.
 *
 * Aside opens an agent tab in the background: the owner's active tab stays active, no window opens or takes focus (c103), and the tab reads
 * as visible only while a REPL call runs, so each timed step runs inside one call. What is timed and how it is read is the same as before:
 * - A cold load opens a new tab on the chat and reads the first frame that shows the chat's lines (`.main .column .line`, which the server's
 *   prepaint already holds), on the page's own clock from its navigation start. The page's URL carries `?t=<chat>`, the query the page's
 *   boot script would add by a reload, so the timed document is the same one the old probe timed after that reload.
 * - A tab switch clicks a chat in the sidebar that the page has not opened and reads the app's own `thread-paint:<id>` measure, with whether
 *   the sidebar's prefetch had brought that chat's first frame back before the click (Resource Timing).
 * Three things differ, since the Aside REPL has no init script, request routing or new browser context:
 * - The watcher goes in right after the navigation commits. When the lines are already painted by then, the load reads the first contentful
 *   paint instead (`via: "first paint"`), since the prepainted lines come in the document's first paint.
 * - Every request other than GET is refused by a wrapped `fetch` from that moment instead of a route, so opening and leaving chats never marks
 *   the owner's chats read or warms a session; the page posts nothing before it, since it marks a chat read only when it leaves it or hides.
 * - A new tab is no new browser profile: the app's hashed assets (cache-control immutable) can come from Aside's cache, and the connection
 *   to the box can be reused. Each load lists how many assets came from the cache and how many over the network, counted once the page's
 *   load event has passed, since the prepainted lines show before app.js arrives.
 */

/** Aside ends each REPL call at 120 s (`aside guide repl`), so a call starts no switch that could run past it. */
const REPL_CALL_MS = 120_000;

export interface ProbeConfig { url: string; loads: number; switches: number; loadTimeoutMs: number; switchTimeoutMs: number; clickTimeoutMs: number; settleMs: number; gapMs: number }

/** The REPL side, defined once as `globalThis.__chatProbe`. Functions passed to `evaluate` run in the page. */
export const PROBE_LIB = String.raw`
globalThis.__chatProbe = (() => {
  let tab = null;

  function pageHold() {
    if (window.__probeHeld) return;
    window.__probeHeld = true;
    performance.setResourceTimingBufferSize(10000);
    const send = window.fetch;
    window.fetch = function (input, init) {
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" && method !== "HEAD") return Promise.reject(new TypeError("the chat page probe sends nothing"));
      return send.call(this, input, init);
    };
    window.__firstFrames = () => performance.getEntriesByType("resource").filter(entry => /\/api\/threads\/[^/]+\/first-frame$/.test(new URL(entry.name).pathname))
      .map(entry => ({ id: decodeURIComponent(new URL(entry.name).pathname.split("/").at(-2)), start: entry.startTime, sent: entry.requestStart, firstByte: entry.responseStart, end: entry.responseEnd }));
    const painted = performance.getEntriesByName("first-contentful-paint")[0];
    if (document.querySelector(".main .column .line") && painted) { window.__shownAt = painted.startTime; window.__shownVia = "first paint"; return; }
    window.__shownVia = "watch";
    const look = () => {
      if (window.__shownAt === undefined && document.querySelector(".main .column .line")) {
        window.__shownAt = -1;
        requestAnimationFrame(() => { window.__shownAt = performance.now(); });
      }
    };
    look();
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  }

  function pageRead() {
    const assets = performance.getEntriesByType("resource").filter(entry => { const url = new URL(entry.name); return url.origin === location.origin && /\.(js|css)$/.test(url.pathname); });
    return {
      shown: window.__shownAt > 0 ? window.__shownAt : null,
      via: window.__shownVia ?? null,
      complete: document.readyState === "complete",
      banner: document.querySelector(".banner[role=alert]")?.textContent?.trim() ?? null,
      cachedAssets: assets.filter(entry => entry.transferSize === 0).length,
      fetchedAssets: assets.filter(entry => entry.transferSize > 0).length,
    };
  }

  function pagePaint({ id, timeoutMs }) {
    return new Promise(resolve => {
      const begin = performance.now();
      const check = () => {
        const ms = performance.getEntriesByName("thread-paint:" + id, "measure")[0]?.duration;
        if (ms !== undefined) resolve(ms);
        else if (performance.now() - begin > timeoutMs) resolve(null);
        else setTimeout(check, 20);
      };
      check();
    });
  }

  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
  };

  function primed(frames, clickAt) {
    if (clickAt === null) return { primed: null, frame: null };
    const before = frames.find(frame => frame.end <= clickAt);
    const own = before ?? frames[0];
    const at = ms => Math.round(ms - clickAt);
    return { primed: Boolean(before), frame: own ? { startMs: at(own.start), sentMs: at(own.sent), firstByteMs: at(own.firstByte), endMs: at(own.end) } : null };
  }

  async function open(url, deadline) {
    const opened = await openTab("about:blank");
    await opened.goto(url, { waitUntil: "commit", timeout: Math.max(1, deadline - Date.now()) });
    for (;;) {
      try { await opened.evaluate(pageHold); return opened; }
      catch (error) { if (Date.now() > deadline) throw error; await sleep(20); }
    }
  }

  async function switchOnce(id, config) {
    await tab.locator('[aria-label="Threads"] a[href="#' + id + '"]').first().click({ timeout: config.clickTimeoutMs });
    const ms = await tab.evaluate(pagePaint, { id, timeoutMs: config.switchTimeoutMs });
    const seen = await tab.evaluate(id => ({
      lines: document.querySelectorAll(".main .column .line").length,
      clickAt: performance.getEntriesByName("thread-switch:" + id, "mark")[0]?.startTime ?? null,
      frames: window.__firstFrames().filter(frame => frame.id === id),
    }), id);
    return { id, ms, lines: seen.lines, ...primed(seen.frames, seen.clickAt) };
  }

  /** The switches that fit in this call, from 'begin': each may take its whole click and paint time and the gap after it. */
  async function switches(ids, config, begin) {
    const done = [];
    for (const id of ids) {
      if (Date.now() + config.clickTimeoutMs + config.switchTimeoutMs + config.gapMs > begin + config.callMs) break;
      done.push(await switchOnce(id, config));
      await sleep(config.gapMs);
    }
    return { done, left: ids.slice(done.length) };
  }

  return {
    async load(url, config) {
      const deadline = Date.now() + config.loadTimeoutMs;
      const opened = await open(url, deadline);
      try {
        for (;;) {
          const seen = await opened.evaluate(pageRead);
          if (seen.shown !== null && seen.complete || Date.now() > deadline) return seen;
          await sleep(50);
        }
      } finally { await closeTab(opened).catch(() => {}); }
    },
    async openSwitches(url, config) {
      const begin = Date.now();
      const deadline = begin + config.loadTimeoutMs;
      tab = await open(url, deadline);
      let listed = 0;
      for (;;) {
        listed = await tab.evaluate(() => document.querySelectorAll('[aria-label="Threads"] a[href^="#"]').length);
        if (listed >= config.switches + 1) break;
        if (Date.now() > deadline) throw new Error("the sidebar listed " + listed + " chats within " + config.loadTimeoutMs + " ms, fewer than " + (config.switches + 1));
        await sleep(100);
      }
      await sleep(config.settleMs);
      const current = new URL(url).hash.slice(1);
      const ids = (await tab.evaluate(() => [...document.querySelectorAll('[aria-label="Threads"] a[href^="#"]')].map(a => a.getAttribute("href").slice(1))))
        .filter((id, index, all) => id && id !== current && all.indexOf(id) === index).slice(0, config.switches);
      const settled = await tab.evaluate(() => window.__firstFrames());
      const settle = { frames: settled.length, medianMs: median(settled.map(frame => frame.end - frame.start)) };
      return { settle, ...(await switches(ids, config, begin)) };
    },
    async moreSwitches(ids, config) { return switches(ids, config, Date.now()); },
    async banner() { return (await tab.evaluate(pageRead)).banner; },
    async close() { if (tab) { const old = tab; tab = null; await closeTab(old).catch(() => {}); } return "ok"; },
  };
})();
"ok";
`;

const js = (value: unknown) => JSON.stringify(value);
const message = (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300);

/** Runs the cold loads, then the tab switches, through `repl`, in the shape chat-page-mac.ts reads (BrowserOutput, less the Mac's load). */
export async function browseInAside(repl: Repl, config: ProbeConfig): Promise<Omit<BrowserOutput, "load">> {
  const started = Date.now();
  const options = js({ ...config, callMs: REPL_CALL_MS });
  await repl.call("define the chat page probe", PROBE_LIB.replace(/"ok";\s*$/, "") + "return 'ok';");
  const loads: BrowserLoad[] = [];
  for (let index = 0; index < config.loads; index++) {
    loads.push(await repl.call<BrowserLoad>(`cold load ${index + 1}`, `return await __chatProbe.load(${js(config.url)}, ${options});`).catch(error => ({ error: message(error) })));
  }
  let tabs: BrowserOutput["tabs"];
  try {
    type Part = { done: BrowserSwitch[]; left: string[] };
    const first = await repl.call<Part & { settle: { frames: number; medianMs: number | null } }>("tab switches", `return await __chatProbe.openSwitches(${js(config.url)}, ${options});`);
    const switches = [...first.done];
    for (let left = first.left; left.length; ) {
      const more = await repl.call<Part>("more tab switches", `return await __chatProbe.moreSwitches(${js(left)}, ${options});`);
      if (!more.done.length) throw new Error(`no switch fits in one ${REPL_CALL_MS / 1000} s REPL call`);
      switches.push(...more.done);
      left = more.left;
    }
    tabs = { switches, banner: await repl.call<string | null>("read the banner", "return await __chatProbe.banner();"), settle: first.settle };
  } catch (error) {
    tabs = { error: message(error) };
  } finally {
    await repl.call("close the switch tab", "return await __chatProbe.close();").catch(() => undefined);
  }
  return { loads, tabs, ms: Date.now() - started };
}
