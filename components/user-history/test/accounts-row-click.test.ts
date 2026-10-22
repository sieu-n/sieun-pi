// Guards the owner's 10-19 answer "Yes, only the button pins": a click on an account row in the Accounts drawer pinned that account to the open
// thread, which is how mac-management and another chat landed on claude16 at 12:33:52Z and 12:57:02Z. A row click now sends no account action;
// Use in this thread sends one.
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { chrome, devtools } from "./devtools-pipe.ts";


const STUBS: Record<string, string> = {
  "./api.ts": `
    const window_ = (kind, label, pct) => ({ kind, label, pct, resetsAt: null });
    const row = (id, current) => ({ id, email: id + "@example.invalid", label: id + "@example.invalid", usage: "10%", session_pct: 10, weekly_pct: 20, usable: true, reason: null,
      current, pinned: false, score: 1, tier: null, windows: [window_("session", "5h", 10), window_("weekly", "week", 20)], usageAt: Date.now(), cooldownUntil: null,
      cooldownReason: null, disabled: false, limitedUntil: null, sessions: 0, resets: null });
    const view = () => ({ sessionId: "thread-1", checkedAt: new Date().toISOString(), poolConfig: null, providers: [
      { provider: "anthropic", rows: [row("claude15", true), row("claude16", false)], poolPin: null,
        resolution: { account: "claude15", email: "claude15@example.invalid", reason: null, pinned: false, selection: { mode: "auto" }, error: null } }] });
    window.__actions = [];
    export const api = {
      accounts: async () => view(),
      accountAction: async action => { window.__actions.push(action); return view(); },
      loginStream: () => () => {}, refreshStream: () => () => {},
      startRefresh: async () => { throw new Error("no refresh in this test"); }, startLogin: async () => { throw new Error("no login in this test"); },
    };`,
  "./store.svelte.ts": `export const store = { selectedId: "thread-1", thread: () => ({ state: { info: { model: { provider: "anthropic", id: "claude-test" } } } }), session: () => undefined, toast: message => { throw new Error(message); } };`,
  "./labels.ts": `export const labels = { setPriority: async () => {} };`,
  "./thread-side.svelte.ts": `export const pushedAccounts = { landed: () => {} };`,
};


test("a click on an account row sends no account action, and Use in this thread sends exactly one", { skip: chrome ? false : "no Chrome on this host" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "accounts-row-click-"));
  // One hook closes Chrome and then removes its profile: as two hooks the rm ran first, since after hooks run in the order they were added,
  // and Chrome still writing the profile failed the test with ENOTEMPTY.
  let browser: ReturnType<typeof devtools> | undefined;
  // Chrome's helper processes outlive the main one and still write the profile, so the rm retries on ENOTEMPTY (release-chat of dc9a5a60, 10-19).
  t.after(async () => { await browser?.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10 }); });
  await symlink(join(import.meta.dirname, "../node_modules"), join(dir, "node_modules"), "dir");
  const plugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;
  const bundled = await build({ stdin: { contents: `import { mount } from "svelte"; import Accounts from "./AccountsSettings.svelte"; mount(Accounts, { target: document.body });`,
    resolveDir: join(import.meta.dirname, "../src/client"), loader: "ts" }, write: false, bundle: true, platform: "browser", format: "iife",
    conditions: ["browser"], plugins: [
      { name: "stubs", setup(build) {
        build.onResolve({ filter: /^\.\/(api|store\.svelte|labels|thread-side\.svelte)\.ts$/ }, args => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: STUBS[args.path]!, loader: "js" }));
      } },
      plugin({ compilerOptions: { runes: true, css: "injected" } })] });
  const script = bundled.outputFiles[0]!.text.replaceAll("</script", "<\\/script");
  await writeFile(join(dir, "page.html"), `<!doctype html><meta charset="utf-8"><body></body><script>${script}</script>`);

  // Chrome opens about:blank and the test navigates once attached: with the page URL on the command line, the first navigation could still swap
  // the context under the first evaluate, which failed release-chat of d31ab0f4 at 20:1xZ on 10-19 with "Execution context was destroyed".
  browser = devtools(chrome!, join(dir, "profile"), "about:blank");
  const { targetInfos } = await browser.send("Target.getTargets");
  const page = targetInfos.find((target: { type: string }) => target.type === "page");
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await browser.send("Page.enable", {}, sessionId);
  const loaded = new Promise<void>(resolve => browser.onEvent("Page.loadEventFired", sessionId, resolve));
  await browser.send("Page.navigate", { url: pathToFileURL(join(dir, "page.html")).href }, sessionId);
  await loaded;
  const evaluate = async (expression: string) => (await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  const ready = await evaluate(`new Promise(resolve => { const look = () => document.querySelectorAll(".row:not(.head)").length === 2 ? resolve(true) : setTimeout(look, 20); look(); })`);
  assert.equal(ready, true);
  const click = async (selector: string) => {
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await browser.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId);
    await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  };
  const actions = () => evaluate(`window.__actions`);
  const claude16 = `.row:not(.head):nth-child(3)`;
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(claude16 + " .email")}).textContent`), "claude16@example.invalid");

  await click(`${claude16} .email`);
  await click(`${claude16} .cell`);
  await click(claude16);
  assert.deepEqual(await actions(), [], "a row click must not pin the account to the thread");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(claude16)}).classList.contains("chosen")`), true, "a row click selects the row");

  await click(`${claude16} button.hint`);
  assert.deepEqual(await actions(), [{ action: "use", provider: "anthropic", account: "claude16", id: "thread-1" }]);
});
