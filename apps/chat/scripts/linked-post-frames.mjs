// Usage from apps/chat: node scripts/linked-post-frames.mjs <chromium|webkit> <post> <room>, with CONTROL=1 for the negative control.
// WebKit connects to a Playwright run-server on ws://127.0.0.1:5794/. BASE picks the chat, live :5184 by default; it only loads pages.
// Frame-by-frame check of a linked post's place. Per rendering frame it records the post's top before layout (rAF, which forces an early
// layout) and again inside a ResizeObserver created after the timeline's own, which runs after the timeline's scroll fix and before paint.
// The painted value of a frame is its last after-fix reading, or its rAF reading when no resize happened in that frame.
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, webkit } = require("playwright-core");
const [engine = "chromium", m = "p37", room = "ch_14ad7a70"] = process.argv.slice(2);
const browser = engine === "webkit" ? await webkit.connect("ws://127.0.0.1:5794/") : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
if (process.env.CONTROL) {
  // Negative control: every ResizeObserver but the probe delivers after paint, so the timeline's fix lands a frame late and the check must see it.
  await page.addInitScript(() => {
    const Native = window.ResizeObserver;
    window.__nativeRO = Native;
    window.ResizeObserver = class extends Native {
      constructor(cb) { super((entries, ob) => setTimeout(() => cb(entries, ob))); }
    };
  });
}
await page.addInitScript((id) => {
  const frames = (window.__frames = []);
  const t0 = performance.now();
  let frame = null, probe = null;
  const read = () => {
    const sc = document.querySelector('[data-testid="timeline"]');
    const row = sc?.querySelector(`[data-message-id="${id}"]`);
    return sc && row ? Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null;
  };
  const step = () => {
    const rows = document.querySelector('[data-testid="timeline"] .rows');
    if (rows && !probe) {
      probe = new (window.__nativeRO ?? ResizeObserver)(() => { if (frame) frame.after.push(read()); });
      probe.observe(rows);
    }
    frame = { t: Math.round(performance.now() - t0), before: read(), after: [] };
    frames.push(frame);
    if (performance.now() - t0 < 6000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}, m);
await page.goto(`${process.env.BASE ?? "http://127.0.0.1:5184"}/#/c/${room}?m=${m}`);
await page.waitForTimeout(6500);
const frames = await page.evaluate(() => window.__frames);
const painted = frames.map((f) => ({ t: f.t, before: f.before, top: f.after.length ? f.after.at(-1) : f.before, fixes: f.after.length })).filter((f) => f.top !== null);
const final = painted.at(-1).top;
const off = painted.filter((f) => Math.abs(f.top - final) > 2);
const early = frames.filter((f) => f.before !== null && Math.abs(f.before - final) > 2);
console.log(JSON.stringify({ engine, post: m, frames: painted.length, first: painted[0], final, paintedOff: off.length, offFrames: off.slice(0, 5), preLayoutReadsOff: early.length, resizeFrames: painted.filter((f) => f.fixes).length }));
await browser.close();
