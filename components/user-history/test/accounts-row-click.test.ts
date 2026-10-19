// Guards the owner's 10-19 answer "Yes, only the button pins": a click on an account row in the Accounts drawer pinned that account to the open
// thread, which is how mac-management and another chat landed on claude16 at 12:33:52Z and 12:57:02Z. A row click now sends no account action;
// Use in this thread sends one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";

const CHROMES = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter((path): path is string => !!path);
const chrome = CHROMES.find(path => existsSync(path));

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

/** Talks Chrome DevTools Protocol over --remote-debugging-pipe: fd 3 carries requests, fd 4 carries replies, each a NUL-ended JSON message. */
function devtools(binary: string, profile: string, url: string) {
  const child = spawn(binary, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--window-size=1100,800", url],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const [input, output] = [child.stdio[3] as NodeJS.WritableStream, child.stdio[4] as NodeJS.ReadableStream];
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let buffered = "", next = 0;
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      const entry = waiting.get(message.id);
      if (!entry) continue;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  return { send, close: () => new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); }) };
}

test("a click on an account row sends no account action, and Use in this thread sends exactly one", { skip: chrome ? false : "no Chrome on this host" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "accounts-row-click-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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

  const browser = devtools(chrome!, join(dir, "profile"), pathToFileURL(join(dir, "page.html")).href);
  t.after(() => browser.close());
  const { targetInfos } = await browser.send("Target.getTargets");
  const page = targetInfos.find((target: { type: string }) => target.type === "page");
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
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
