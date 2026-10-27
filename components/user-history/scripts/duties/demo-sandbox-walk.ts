import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { cpus, homedir, hostname, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_URL, REPO, WALK_FILE, WALK_SOURCE, type BoxLoad, type WalkReport } from "./demo-sandbox.ts";

/**
 * The offline walk of the 5180 demo for d1 (demo-sandbox.ts), driven through the owner's Aside browser on the Mac where 5180 runs. Owner c177,
 * 10-27: "can you remove Headless browser???? NEVER put it back in. we'll always use Aside only." Until then the walk was
 * apps/virev-demo/tests/e2e/offline.spec.ts under Playwright with its browser on us-metal02 (shot-browser.mjs --run).
 *
 * The precheck starts it on the Mac, detached (WALK_COMMAND). It speaks MCP to one `aside mcp` process, so the REPL keeps its state between
 * calls, opens one background tab per test and closes it at the end. It walks the same pages as offline.spec.ts did: per scenario /configure,
 * the old campaigns URL, a full load of every /app page, a warmup switch to each, TRIES timed switch passes and TRIES - 1 more load passes; then
 * the marketing, legal and auth pages. It writes the same Playwright-shaped JSON report to WALK_FILE: one spec per test with a `page-timing`
 * annotation per page and scenario, a `box-load` annotation per timed pass, and the failed checks as error messages.
 *
 * The Aside REPL has no addInitScript and no request or console events, so each document gets its observers right after its navigation
 * commits, and buffered entries cover what came before: outside requests and failed assets from Resource Timing, CSP violations from a buffered
 * ReportingObserver (violations from Aside's own extension are skipped), and long tasks from a buffered PerformanceObserver. A document the app
 * replaces between two reads (the /configure bounce page) can lose its entries; the dev server's own egress record still lists every outside
 * call it refused. A load's first shown frame is watched from the commit, so a page that showed before the watcher ran reads at the watcher's start.
 */

/** Each REPL call ends at 120 s in Aside; a call with no answer by this time counts as failed, so a hung Aside cannot hang the walk. */
const CALL_TIMEOUT_MS = 150_000;
/** The whole walk stops here; the Playwright walk took 8.4 min for 3 tries of every page through us-metal02 (10-20). */
const WALK_TIMEOUT_MS = 45 * 60_000;
/** A page that shows nothing in this long reads as this long; demo-sandbox.ts reads a missing show as PAGE_TIMEOUT_MS, the same 30 s. */
const SHOW_TIMEOUT_MS = 30_000;
/** How long a /configure or a redirect gets to land on its world: a cold /configure took 41 s through the box's tunnel on 10-19. */
const LAND_TIMEOUT_MS = 100_000;
/** Each page's switch and load are timed this often, and d1 reads the fastest, so a busy moment spoils one try, not the page. */
export const TRIES = 3;
export const SCENARIOS = ["kbeauty-brand", "fresh-start"];
export const PAGES = ["/app", "/app/search", "/app/discover", "/app/dashboards", "/app/campaigns", "/app/watchlist", "/app/outreach", "/app/inbox", "/app/connections"];
export const MARKETING_PAGES = ["/", "/pricing", "/privacy", "/sign-in"];
/** An app's URL from before each app moved to /app/<app name> (owner, 10-22), which hooks.server.ts sends on with its path and query. */
export const OLD_URL = { scenario: "kbeauty-brand", from: "/campaigns/heartleaf-toner-us?view=home", to: "/app/campaigns/heartleaf-toner-us" };
export const MARKETING_TITLE = "marketing, legal and auth pages load their fonts from the app";
export const scenarioTitle = (scenario: string) => `${scenario}: every browser and server request stays on localhost`;

/**
 * The REPL side of the walk, defined once as `globalThis.__walk`. Functions passed to `evaluate` run in the page. It keeps what every document
 * of the current test showed in `seen`, read before each navigation and at the end of each step.
 */
export const REPL_LIB = String.raw`
globalThis.__walk = (() => {
  const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
  const ASSETS = ["img", "script", "link", "css", "video", "audio", "font"];
  let tab = null;
  let seen = { outside: [], violations: [], failed: [] };
  const destroyed = (error) => /Execution context was destroyed|navigation|Target closed|detached/i.test(String(error));

  function pageInstall() {
    const w = window;
    if (w.__walkShows) return { status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0, url: location.href };
    try { performance.setResourceTimingBufferSize(100000); } catch {}
    w.__walkLong = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.__walkLong.push([entry.startTime, entry.duration]); }).observe({ type: "longtask", buffered: true });
    const BUSY = '.skeleton, [aria-busy="true"]';
    const busy = new Map();
    const onScreen = new IntersectionObserver((entries) => { for (const entry of entries) if (busy.has(entry.target)) busy.set(entry.target, entry.isIntersecting); });
    let dirty = true;
    new MutationObserver(() => { dirty = true; }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"] });
    const sync = (main) => {
      const now = new Set(main.querySelectorAll(BUSY));
      for (const element of busy.keys()) if (!now.has(element)) { onScreen.unobserve(element); busy.delete(element); }
      for (const element of now) if (!busy.has(element)) { busy.set(element, null); onScreen.observe(element); }
    };
    w.__walkShows = () => {
      const main = document.querySelector("main");
      if (!main) return false;
      if (dirty) { dirty = false; sync(main); }
      for (const shown of busy.values()) if (shown !== false) return false;
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim() && !node.parentElement?.hasAttribute("data-walk-old")) return true;
      return false;
    };
    w.__walkFirstShown = null;
    const watch = () => { if (w.__walkShows()) w.__walkFirstShown = performance.now(); else requestAnimationFrame(watch); };
    requestAnimationFrame(watch);
    return { status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0, url: location.href };
  }

  async function pageCollect({ LOCAL, ASSETS }) {
    const w = window;
    const out = { outside: [], violations: [], failed: [] };
    if (!w.__walkReports) {
      w.__walkCsp = [];
      w.__walkReports = new ReportingObserver((reports) => w.__walkCsp.push(...reports), { types: ["csp-violation"], buffered: true });
      w.__walkReports.observe();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const report of [...w.__walkCsp.splice(0), ...w.__walkReports.takeRecords()]) {
      const body = report.body || {};
      if (String(body.sourceFile || "").startsWith("chrome-extension")) continue;
      out.violations.push(location.href + ": " + body.effectiveDirective + " blocked " + body.blockedURL);
    }
    const done = (w.__walkCollected ??= new Set());
    for (const entry of [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")]) {
      const key = entry.entryType + " " + entry.name + " " + entry.startTime;
      if (done.has(key)) continue;
      done.add(key);
      const url = new URL(entry.name);
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) continue;
      if (!LOCAL.includes(url.hostname)) { out.outside.push(location.href + " -> " + entry.name); continue; }
      const type = entry.entryType === "navigation" ? "document" : entry.initiatorType;
      const status = entry.responseStatus ?? 0;
      if (status >= 500 || (status === 404 && ASSETS.includes(type))) out.failed.push(status + " " + type + " " + url.pathname + url.search + " (on " + location.href + ")");
    }
    return out;
  }

  function pageTimeLoad() {
    const clock = window;
    const until = clock.__walkFirstShown ?? performance.now();
    const longMs = clock.__walkLong.filter(([at]) => at < until).reduce((sum, [, duration]) => sum + duration, 0);
    return { ms: clock.__walkFirstShown === null ? null : Math.round(clock.__walkFirstShown), longMs: Math.round(longMs), origin: performance.timeOrigin };
  }

  async function pageSwitch({ path, timeout, clickKey }) {
    const clock = window;
    for (const element of document.querySelectorAll("main *")) element.setAttribute("data-walk-old", "");
    const world = new URLSearchParams(location.search).get("world");
    const href = world ? path + "?world=" + encodeURIComponent(world) : path;
    const begin = performance.now();
    let start = begin;
    for (;;) {
      const link = document.createElement("a");
      link.href = href;
      link.setAttribute("data-sveltekit-preload-data", "off");
      document.body.append(link);
      const late = performance.now() - begin > timeout;
      let taken = false;
      const cancelNative = (event) => { taken = event.defaultPrevented; if (!taken && !late) event.preventDefault(); };
      addEventListener("click", cancelNative, { once: true });
      sessionStorage.setItem(clickKey, String(performance.timeOrigin + performance.now()));
      start = performance.now();
      link.click();
      link.remove();
      removeEventListener("click", cancelNative);
      if (taken || late) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const end = await new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        if (location.pathname === path && clock.__walkShows()) resolve(now);
        else if (now - start > timeout) resolve(null);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    const until = end ?? performance.now();
    const longMs = clock.__walkLong.filter(([at]) => at >= start && at < until).reduce((sum, [, duration]) => sum + duration, 0);
    return { ms: end === null ? null : Math.round(end - start), longMs: Math.round(longMs) };
  }

  async function install() {
    for (let attempt = 0; ; attempt++) {
      try { return await tab.evaluate(pageInstall); }
      catch (error) { if (attempt >= 40 || !destroyed(error)) throw error; await sleep(250); }
    }
  }

  async function collect() {
    if (!tab) return;
    const out = await tab.evaluate(pageCollect, { LOCAL, ASSETS }).catch(() => null);
    if (out) for (const key of Object.keys(seen)) seen[key].push(...out[key]);
  }

  async function goto(url) {
    await collect();
    await tab.goto(url, { waitUntil: "commit" });
    return install();
  }

  async function land(test, timeout) {
    const begin = Date.now();
    for (;;) {
      const url = new URL(tab.url());
      if (test(url)) { await install(); return url.href; }
      if (Date.now() - begin > timeout) throw new Error("still on " + url.href + " after " + timeout + " ms");
      await sleep(200);
    }
  }

  async function timeLoad(timeout) {
    const begin = Date.now();
    for (;;) {
      try {
        if (await tab.evaluate(() => window.__walkFirstShown !== null) || Date.now() - begin > timeout) return await tab.evaluate(pageTimeLoad);
      } catch (error) { if (!destroyed(error)) throw error; await install(); }
      await sleep(200);
    }
  }

  async function timeSwitch(path, timeout) {
    try {
      return { ...(await tab.evaluate(pageSwitch, { path, timeout, clickKey: "__walkClickAt" })), document: false };
    } catch (error) {
      if (!destroyed(error)) throw error;
      for (let reload = 0; ; reload++) {
        await tab.waitForLoadState("load");
        if (new URL(tab.url()).pathname !== path) throw error;
        try {
          await install();
          const loaded = await timeLoad(timeout);
          const clickAt = Number(await tab.evaluate(() => sessionStorage.getItem("__walkClickAt")));
          const ms = loaded.ms === null || !clickAt ? null : Math.round(loaded.origin + loaded.ms - clickAt);
          return { ms, longMs: loaded.longMs, document: true };
        } catch (again) { if (reload > 0 || !destroyed(again)) throw again; }
      }
    }
  }

  return {
    async open() { tab = await openTab("about:blank"); seen = { outside: [], violations: [], failed: [] }; return tab.targetId; },
    async reopen() { const old = tab; tab = null; if (old) await Promise.race([closeTab(old).catch(() => {}), sleep(5000)]); tab = await openTab("about:blank"); },
    async close() { if (tab) { await collect(); const old = tab; tab = null; await closeTab(old).catch(() => {}); } return seen; },
    seen: () => seen,
    path: () => new URL(tab.url()).pathname,
    goto, land, collect, timeLoad, timeSwitch,
    async settle(waitMs, scroll) {
      await tab.waitForLoadState("load");
      await sleep(waitMs);
      if (scroll) { await tab.evaluate(() => window.scrollBy(0, 4000)); await sleep(2000); }
      await collect();
    },
  };
})();
"ok";
`;

export interface Repl { call: <T>(title: string, body: string) => Promise<T>; stop: () => void }

/**
 * One `aside mcp` process over stdio, so the REPL scope lives for the whole walk. `call` runs `body` (the inside of an async function, which
 * returns a JSON value) and resolves that value; a REPL error or no answer within CALL_TIMEOUT_MS rejects.
 */
export function asideRepl(cli: string): Repl {
  const child: ChildProcess = spawn(cli, ["mcp"], { stdio: ["pipe", "pipe", "ignore"], detached: true });
  let buffer = "", nextId = 0, exited: string | null = null;
  const waiting = new Map<number, (message: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }) => void>();
  child.on("error", error => { exited = error.message; for (const answer of waiting.values()) answer({ error: { message: exited } }); waiting.clear(); });
  child.on("exit", code => { exited = `aside mcp exited with code ${code}`; for (const answer of waiting.values()) answer({ error: { message: exited } }); waiting.clear(); });
  child.stdin!.on("error", () => { /* the exit handler reports it */ });
  child.stdout!.on("data", chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      let message: { id?: number };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id === "number") { waiting.get(message.id)?.(message as never); waiting.delete(message.id); }
    }
  });
  const send = (method: string, params: unknown) => new Promise<{ result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }>(answer => {
    if (exited) return answer({ error: { message: exited } });
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); answer({ error: { message: `no answer from aside mcp within ${CALL_TIMEOUT_MS} ms` } }); }, CALL_TIMEOUT_MS);
    waiting.set(id, message => { clearTimeout(timer); answer(message); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const ready = (async () => {
    const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo-sandbox-walk", version: "1" } });
    if (init.error) throw new Error(`aside mcp initialize: ${init.error.message}`);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();
  return {
    async call<T>(title: string, body: string): Promise<T> {
      await ready;
      const code = `{ const __walkValue = await (async () => { ${body} })(); console.log("WALK_RESULT " + JSON.stringify(__walkValue ?? null)); }`;
      const answer = await send("tools/call", { name: "repl", arguments: { title, code } });
      if (answer.error) throw new Error(answer.error.message ?? "aside mcp error");
      const text = (answer.result?.content ?? []).map(item => item.text ?? "").join("\n");
      if (answer.result?.isError) throw new Error(text.split("\n").find(line => line.trim()) ?? "REPL error");
      const line = text.split("\n").reverse().find(entry => entry.startsWith("WALK_RESULT "));
      if (!line) throw new Error(`no result in the REPL output: ${text.slice(0, 300)}`);
      return JSON.parse(line.slice("WALK_RESULT ".length)) as T;
    },
    stop() { child.stdin!.end(); setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 2000).unref(); },
  };
}

interface Shown { ms: number | null; longMs: number }
interface Seen { outside: string[]; violations: string[]; failed: string[] }
interface Annotation { type: string; description: string }
export interface WalkTest { title: string; annotations: Annotation[]; errors: string[] }
export interface StepFailure { path: string; step: string; error: string }

const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0]!;
const js = (value: unknown) => JSON.stringify(value);
/** A tab that closed or a REPL call that never answered gets a new tab before the step runs again. */
const tabGone = (error: unknown) => /Target closed|has been closed|detached|crash|no answer from aside mcp|timed? ?out/i.test(String(error));

/** The failure messages a test ends with, in the order offline.spec.ts checked them; the first failed check of expectClean ends the list. */
export function testErrors(failures: readonly StepFailure[], pages: number, seen: Seen, egress: string[] | Error): string[] {
  const errors: string[] = [];
  if (failures.length) errors.push(`${new Set(failures.map(failure => failure.path)).size} of ${pages} pages failed\n\nReceived: ${JSON.stringify(failures, null, 2)}`);
  const checks: [string, string[] | Error][] = [
    ["browser requests to another host", seen.outside],
    ["CSP violations", seen.violations],
    ["5xx answers and missing assets from the dev server", seen.failed],
    ["outside calls the dev server refused (GET /__demo/egress)", egress],
  ];
  for (const [what, found] of checks) {
    if (found instanceof Error) { errors.push(`${what}: ${found.message}`); break; }
    if (found.length) { errors.push(`${what}\n\nExpected: []\nReceived: ${JSON.stringify([...new Set(found)], null, 2)}`); break; }
  }
  return errors;
}

/** The Playwright-shaped JSON report demo-sandbox.ts reads (readWalk). */
export function walkReport(startedAt: number, tests: readonly WalkTest[]): WalkReport {
  return {
    stats: { startTime: new Date(startedAt).toISOString() },
    suites: [{ file: WALK_SOURCE, specs: tests.map(test => ({ title: test.title, file: WALK_SOURCE, tests: [{ results: [{
      status: test.errors.length ? "failed" : "passed", errors: test.errors.map(message => ({ message })), annotations: test.annotations,
    }] }] })) }],
  };
}

/** Every outside call the dev server refused since it started, one line each, or the error that read gave. */
async function serverEgress(): Promise<string[] | Error> {
  try {
    const response = await fetch(`${BASE_URL}/__demo/egress`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return new Error(`GET /__demo/egress gave HTTP ${response.status}`);
    const { entries } = await response.json() as { entries: { at: string; kind: string; target: string; reason: string; world: string | null; stack: string[] }[] };
    return entries.map(e => `${e.at} ${e.kind} ${e.target}: ${e.reason} (world ${e.world ?? "none"}; ${e.stack[0] ?? "no app frame"})`);
  } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

/** The 1-minute load and core count of this host, which runs Aside and so the walk's browser. */
const hostLoad = (): Omit<Extract<BoxLoad, { load1: number }>, "scenario" | "pass"> => ({ host: hostname(), load1: Math.round(loadavg()[0]! * 100) / 100, cores: cpus().length });

/** One test's tab and steps: a step that fails runs once more, on a new tab when the old one closed or stopped answering, and fails after that. */
function testWalk(repl: Repl) {
  const failures: StepFailure[] = [];
  async function step<T>(path: string, name: string, run: (attempt: number) => Promise<T>): Promise<T | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await run(attempt);
        await repl.call("collect", "await __walk.collect();").catch(() => {});
        return value;
      } catch (error) {
        if (tabGone(error)) await repl.call("new tab", "await __walk.reopen();").catch(() => {});
        if (attempt === 2) { failures.push({ path, step: name, error: firstLine(error) }); return null; }
      }
    }
  }
  return { step, failures };
}

async function scenarioTest(repl: Repl, scenario: string): Promise<WalkTest> {
  const annotations: Annotation[] = [];
  const note = (type: string, value: unknown) => annotations.push({ type, description: JSON.stringify(value) });
  await repl.call(`open a tab for ${scenario}`, "return await __walk.open();");
  const walk = testWalk(repl);
  let world = "";
  const inWorld = (path: string) => world ? `${path}?world=${encodeURIComponent(world)}` : path;
  const goto = (url: string) => repl.call<{ status: number; url: string }>(`open ${url}`, `return await __walk.goto(${js(BASE_URL + url)});`);

  await walk.step("/configure", "configure", async attempt => {
    if (attempt === 1) {
      const csp = (await fetch(`${BASE_URL}/configure?scenario=${scenario}`, { redirect: "manual", signal: AbortSignal.timeout(LAND_TIMEOUT_MS) })).headers.get("content-security-policy") ?? "";
      if (!csp.includes("img-src 'self'")) throw new Error(`/configure has no img-src 'self' in its CSP header: ${JSON.stringify(csp)}`);
    }
    await goto(`/configure?scenario=${scenario}`);
    const landed = await repl.call<string>("land on the world", `return await __walk.land(u => /^\\/app(\\/|$)/.test(u.pathname) && u.searchParams.has("world"), ${LAND_TIMEOUT_MS});`);
    world = new URL(landed).searchParams.get("world")!;
  });
  if (world && scenario === OLD_URL.scenario) {
    await walk.step(OLD_URL.to, "old url", async () => {
      const { status } = await goto(`${OLD_URL.from}&world=${encodeURIComponent(world)}`);
      if (status >= 400) throw new Error(`${OLD_URL.from} gave HTTP ${status}`);
      const landed = new URL(await repl.call<string>("land on the moved url", `return await __walk.land(u => u.pathname === ${js(OLD_URL.to)}, ${LAND_TIMEOUT_MS});`));
      if (landed.searchParams.get("view") !== "home") throw new Error(`the old URL lost its query: ${landed.href}`);
      if (landed.searchParams.get("world") !== world) throw new Error(`the old URL lost its world: ${landed.href}`);
    });
  }

  const loads = new Map<string, { landed: string; tries: Shown[] }>();
  const timeLoad = () => repl.call<Shown>("time the load", `return await __walk.timeLoad(${SHOW_TIMEOUT_MS});`);
  const landWorld = () => repl.call<string>("land on the world", `return await __walk.land(u => u.searchParams.has("world"), ${LAND_TIMEOUT_MS});`);
  for (const path of PAGES) {
    if (!world) break;
    const loaded = await walk.step(path, "load", async () => {
      const { status } = await goto(inWorld(path));
      if (status >= 400) throw new Error(`${path} gave HTTP ${status}`);
      await landWorld();
      const shown = await timeLoad();
      const landed = await repl.call<string>("read the path", "return __walk.path();");
      await repl.call("let late requests land", "await __walk.settle(3000, true);");
      return { ...shown, landed };
    });
    if (loaded) loads.set(path, { landed: loaded.landed, tries: [{ ms: loaded.ms, longMs: loaded.longMs }] });
  }
  const from = (index: number) => {
    for (let back = 1; back <= PAGES.length; back++) {
      const before = loads.get(PAGES.at(index - back)!);
      if (before) return before.landed;
    }
    return null;
  };
  const switchTo = (index: number, name: string) => {
    const target = loads.get(PAGES[index]!)!.landed;
    const start = from(index)!;
    return walk.step(target, name, async attempt => {
      if (attempt > 1 || await repl.call<string>("read the path", "return __walk.path();") !== start) {
        await goto(inWorld(start));
        await landWorld();
        await timeLoad();
      }
      return repl.call<Shown & { document: boolean }>(`switch to ${target}`, `return await __walk.timeSwitch(${js(target)}, ${SHOW_TIMEOUT_MS});`);
    });
  };
  const beforeWarmup = walk.failures.length;
  for (const index of PAGES.keys()) if (loads.has(PAGES[index]!)) await switchTo(index, "first switch");
  for (const failure of walk.failures.splice(beforeWarmup)) note("warmup-failed", { scenario, ...failure });
  const switches = new Map<string, (Shown & { document: boolean })[]>();
  for (let round = 1; round <= TRIES; round++) {
    note("box-load", { scenario, pass: `switch ${round}`, at: new Date().toISOString(), ...hostLoad() });
    for (const [index, path] of PAGES.entries()) {
      if (!loads.has(path)) continue;
      const switched = await switchTo(index, `timed switch ${round}`);
      if (switched) switches.set(path, [...(switches.get(path) ?? []), switched]);
    }
  }
  for (let round = 2; round <= TRIES; round++) {
    note("box-load", { scenario, pass: `load ${round}`, at: new Date().toISOString(), ...hostLoad() });
    for (const [path, loaded] of loads) {
      const again = await walk.step(path, `load ${round}`, async () => {
        await goto(inWorld(path));
        await landWorld();
        return timeLoad();
      });
      if (again) loaded.tries.push(again);
    }
  }
  for (const path of PAGES) {
    const loaded = loads.get(path);
    note("page-timing", {
      scenario, path: loaded?.landed ?? path,
      switches: (switches.get(path) ?? []).map(({ ms, longMs, document }) => ({ ms, long_ms: longMs, document })),
      loads: (loaded?.tries ?? []).map(({ ms, longMs }) => ({ ms, long_ms: longMs })),
    });
  }
  for (const failure of walk.failures) note("page-failed", { scenario, ...failure });
  const seen = await repl.call<Seen>("close the tab", "return await __walk.close();");
  return { title: scenarioTitle(scenario), annotations, errors: testErrors(walk.failures, PAGES.length, seen, await serverEgress()) };
}

async function marketingTest(repl: Repl): Promise<WalkTest> {
  const annotations: Annotation[] = [];
  await repl.call("open a tab for the marketing pages", "return await __walk.open();");
  const walk = testWalk(repl);
  for (const path of MARKETING_PAGES) {
    await walk.step(path, "load", async () => {
      const { status } = await repl.call<{ status: number }>(`open ${path}`, `return await __walk.goto(${js(BASE_URL + path)});`);
      if (status >= 400) throw new Error(`${path} gave HTTP ${status}`);
      await repl.call("let late requests land", "await __walk.settle(2000, false);");
    });
  }
  for (const failure of walk.failures) annotations.push({ type: "page-failed", description: JSON.stringify({ scenario: "marketing", ...failure }) });
  const seen = await repl.call<Seen>("close the tab", "return await __walk.close();");
  return { title: MARKETING_TITLE, annotations, errors: testErrors(walk.failures, MARKETING_PAGES.length, seen, await serverEgress()) };
}

/** A test that could not run at all, such as one whose tab never opened, as one failed spec. */
const brokenTest = (title: string, error: unknown): WalkTest => ({ title, annotations: [], errors: [`the test did not run: ${firstLine(error)}`] });

export async function runWalk(repl: Repl, now: () => number = Date.now): Promise<WalkReport> {
  const startedAt = now();
  await repl.call("define the walk", REPL_LIB.replace(/"ok";\s*$/, "") + "return 'ok';");
  const tests: WalkTest[] = [];
  for (const scenario of SCENARIOS) tests.push(await scenarioTest(repl, scenario).catch(error => brokenTest(scenarioTitle(scenario), error)));
  tests.push(await marketingTest(repl).catch(error => brokenTest(MARKETING_TITLE, error)));
  return walkReport(startedAt, tests);
}

/** The Aside CLI: ASIDE_CLI, else ~/.local/bin/aside, where the Mac has it; a plain `ssh mac` PATH lacks ~/.local/bin. */
export const asideCli = () => process.env.ASIDE_CLI || join(homedir(), ".local/bin/aside");

async function main(): Promise<void> {
  const repl = asideRepl(asideCli());
  const hardStop = setTimeout(() => { process.stderr.write(`demo-sandbox-walk: the walk ran past ${WALK_TIMEOUT_MS / 60_000} min and stopped\n`); repl.stop(); process.exit(1); }, WALK_TIMEOUT_MS);
  try {
    await repl.call("check Aside", "return 'ok';").catch(error => { throw new Error(`Aside did not answer: ${firstLine(error)}`); });
    const report = await runWalk(repl);
    const file = join(REPO, WALK_FILE);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2) + "\n");
    await rename(`${file}.tmp`, file);
  } catch (error) {
    process.stderr.write(`demo-sandbox-walk: ${firstLine(error)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
    repl.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
