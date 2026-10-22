// Guards the owner's 10-22 ask "Change this box's queue limits from the chat app on the box itself. bs": every up box on Settings > Hosts gets the
// queue switch and the two limit forms, and a remote card writes through api/hosts/queue with its host name instead of telling him to go to that box.
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { chrome, openPage } from "./devtools-pipe.ts";

const API_STUB = `
  const reading = (workingMax, enabled) => ({ state: "read", enabled, workingMax, workingMaxSet: null, treeWorkingMax: 4, working: [], queued: [], rows: [] });
  const machine = { platform: "linux", cpu: { percent: 10, cores: 8, load: [1, 1, 1] },
    memory: { usedBytes: 2 ** 30, totalBytes: 8 * 2 ** 30, swapUsedBytes: null, swapTotalBytes: null, pressure: null, groups: null } };
  const card = (name, self, queue) => ({ name, address: name + ".invalid", roles: [], self, state: "up", daemon: "answering", pingMs: 1, machine, queue, sessions: null });
  window.__remote = reading(8, true);
  window.__hostPosts = [];
  window.__selfPosts = [];
  export const api = {
    hosts: async () => {
      const remote = window.__remote;
      window.__asked = (window.__asked ?? 0) + 1;
      if (window.__hold) await window.__hold;
      return { hosts: [card("us-metal02", true, reading(30, true)), card("metal03", false, remote)], registryError: null, checkedAt: Date.now(), lastHost: null, lastWorkspace: {} };
    },
    agentQueue: async () => ({ pool: reading(30, true), idleEvictionMinutes: 30, history: [{ at: Date.now() - 3600000, finished: 3, medianWaitS: 5 }] }),
    setAgentQueue: async input => { window.__selfPosts.push(input); throw new Error("the self card must not write in this test"); },
    setHostQueue: async input => {
      window.__hostPosts.push(input);
      const pool = window.__remote;
      window.__remote = input.action === "queue" ? { ...pool, enabled: input.on } : input.action === "mac" ? { ...pool, workingMax: input.value } : { ...pool, treeWorkingMax: input.value };
      return window.__remote;
    },
  };`;

test("a remote Hosts card sets its queue limits through api/hosts/queue with the host name", { skip: chrome ? false : "no Chrome on this host" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "hosts-remote-queue-"));
  let close: (() => Promise<void>) | undefined;
  // Chrome's helper processes outlive the main one and still write the profile, so the rm retries on ENOTEMPTY (as accounts-row-click.test.ts).
  t.after(async () => { await close?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10 }); });
  await symlink(join(import.meta.dirname, "../node_modules"), join(dir, "node_modules"), "dir");
  const plugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;
  const bundled = await build({ stdin: { contents: `import { mount } from "svelte"; import Hosts from "./HostsSettings.svelte"; mount(Hosts, { target: document.body });`,
    resolveDir: join(import.meta.dirname, "../src/client"), loader: "ts" }, write: false, bundle: true, platform: "browser", format: "iife",
    conditions: ["browser"], plugins: [
      { name: "stubs", setup(build) {
        build.onResolve({ filter: /^\.\/api\.ts$/ }, args => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: API_STUB, loader: "js" }));
      } },
      plugin({ compilerOptions: { runes: true, css: "injected" } })] });
  const script = bundled.outputFiles[0]!.text.replaceAll("</script", "<\\/script");
  await writeFile(join(dir, "page.html"), `<!doctype html><meta charset="utf-8"><body></body><script>${script}</script>`);

  const { browser, evaluate } = await openPage(chrome!, join(dir, "profile"), pathToFileURL(join(dir, "page.html")).href);
  close = browser.close;
  const until = (condition: string) => evaluate(`new Promise(resolve => { const look = () => (${condition}) ? resolve(true) : setTimeout(look, 20); look(); })`);
  await until(`document.querySelectorAll("details.host").length === 2`);
  await evaluate(`document.querySelectorAll("details.host").forEach(card => { card.open = true; })`);
  const remote = `section[aria-label="Agent queue on metal03"]`;
  await until(`document.querySelector(${JSON.stringify(remote)}) && document.querySelector('section[aria-label="Agent queue"] form.limit input')`);

  const labels = await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${remote} form.limit label`)})].map(label => label.textContent)`);
  assert.deepEqual(labels, ["Agents working on this box", "Agents working per chat"], "the remote card has the two pool limits and no idle unload field");
  assert.equal(await evaluate(`document.body.textContent.includes("from the chat app on the box itself")`), false);
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(`section[aria-label="Agent queue"] .history`)}).length`), 1, "the self card shows its turn history");
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(`${remote} .history`)}).length`), 0, "the remote card shows no turn history");
  const ids = await evaluate(`[...document.querySelectorAll("form.limit input")].map(input => input.id)`);
  assert.equal(ids.length, 5, "the self card has three limit fields and the remote card two");
  assert.equal(new Set(ids).size, ids.length, `every limit field id is unique on the page: ${ids}`);
  assert.equal(await evaluate(`[...document.querySelectorAll("form.limit label")].every(label => label.closest("form").contains(document.getElementById(label.htmlFor)))`), true);

  const macInput = `${remote} form.limit:nth-child(1) input`;
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(macInput)}).value`), "8");
  // A Hosts poll asked for before the write answers after it with the old limit, as api/hosts did on 10-22, and the card keeps the written 12.
  await evaluate(`window.__hold = new Promise(resolve => { window.__release = resolve; }); window.__askedBefore = window.__asked`);
  await until(`window.__asked > window.__askedBefore`);
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(macInput)}); input.value = "12"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await evaluate(`document.querySelector(${JSON.stringify(`${remote} form.limit:nth-child(1) button`)}).click()`);
  await until(`window.__hostPosts.length === 1 && document.querySelector(${JSON.stringify(macInput)}).value === "12" && !document.querySelector(${JSON.stringify(macInput)}).disabled`);
  await evaluate(`window.__hold = null; window.__release()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 300))`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(macInput)}).value`), "12", "a poll asked for before the write does not bring the old limit back");
  await evaluate(`document.querySelector(${JSON.stringify(`${remote} button[role=switch]`)}).click()`);
  await until(`window.__hostPosts.length === 2 && document.querySelector(${JSON.stringify(`${remote} button[role=switch]`)}).getAttribute("aria-checked") === "false"`);
  assert.deepEqual(await evaluate(`window.__hostPosts`), [{ host: "metal03", action: "mac", value: 12 }, { host: "metal03", action: "queue", on: false }]);
  assert.deepEqual(await evaluate(`window.__selfPosts`), [], "a remote change never writes this box's own queue");
});
