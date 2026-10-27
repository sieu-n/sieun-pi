// Guards the owner's 10-19 report: an Off account could not be deliberately picked for a new chat or an existing thread.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { render } from "svelte/server";
import type { ChatBackend } from "../src/chat-backend.ts";

const dir = await mkdtemp(join(tmpdir(), "manual-off-account-"));
const cli = join(dir, "pi-pool.mjs");
const state = join(dir, "pins.json");
const previous = process.env.PI_POOL_BIN;
await writeFile(state, "{}");
await writeFile(cli, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(state)};
const pins = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2), command = args[0];
const flag = name => args[args.indexOf(name) + 1];
const selection = session => pins[session] ? { mode: "manual", account_id: pins[session] } : { mode: "auto" };
const listing = (provider, session) => ({ provider, selection: selection(session), rows: provider === "anthropic" ? [
  { id: "off-account", email: "off@example.invalid", label: "Off account", usage: "0%", reason: "disabled", usable: false, disabled: true, current: false, pinned: false },
  { id: "auto-account", email: "auto@example.invalid", usage: "0%", reason: null, usable: true, disabled: false, current: true, pinned: false }] : [] });
const who = session => ({ providers: { anthropic: { account: pins[session] || "auto-account", email: pins[session] ? "off@example.invalid" : "auto@example.invalid", pinned: !!pins[session], selection: selection(session) } } });
let answer = {};
if (command === "use") {
  const session = flag("--session");
  if (args[1] === "--follow") delete pins[session];
  else { if (args[1] !== "off-account" && args[1] !== "auto-account") { console.error("unknown account"); process.exit(2); } pins[session] = args[1]; }
  writeFileSync(file, JSON.stringify(pins));
} else if (command === "snapshot") {
  const threads = [];
  const part = value => ({ code: 0, out: JSON.stringify(value), err: "" });
  for (let i = 0; i < args.length; i++) if (args[i] === "--thread") {
    const session = args[++i] || null, model = args[++i] || null;
    threads.push({ session, model, who: part(who(session)), ls: { anthropic: part(listing("anthropic", session)), "openai-codex": part(listing("openai-codex", session)) } });
  }
  answer = { queue: part({}), config: part({}), threads };
}
console.log(JSON.stringify(answer));
`, { mode: 0o700 });
process.env.PI_POOL_BIN = cli;
const { accountsView, parsePoolSelection, parsePoolResolution, poolAdmitsNow } = await import("../src/chat-pool.ts");
const { startChatServer } = await import("../src/chat-server.ts");
const { asset } = await import("../src/chat-assets.ts");
after(async () => { if (previous === undefined) delete process.env.PI_POOL_BIN; else process.env.PI_POOL_BIN = previous; await rm(dir, { recursive: true, force: true }); });

const manual = { mode: "manual", account_id: "off-account" } as const;
const off = { id: "off-account", email: "off@example.invalid", usage: "0%", reason: "disabled", usable: false, current: false, pinned: false, disabled: true };
const part = (value: unknown, code = 0) => ({ code, out: JSON.stringify(value), err: "" });
const parts = (selected: unknown) => ({ who: part({ providers: { anthropic: selected } }), ls: {
  anthropic: part({ provider: "anthropic", selection: manual, rows: [off] }), "openai-codex": part({ provider: "openai-codex", selection: { mode: "auto" }, rows: [] }) } });

test("manual selection keeps its identity and error when resolution cannot serve or the account is gone", () => {
  const failure = { selection: manual, account: null, error: "Sign-in expired for off@example.invalid", reason: "needs-reauth" };
  const reading = accountsView("thread", { ...parts(failure), at: 0 }, null).providers[0]!;
  assert.deepEqual(reading.resolution?.selection, manual);
  assert.equal(reading.resolution?.error, failure.error);
  assert.equal(reading.rows[0]?.disabled, true);
  assert.equal(reading.rows[0]?.usable, false);
  assert.deepEqual(parsePoolResolution({ providers: { anthropic: { ...failure, error: "Pinned account was removed" } } }, "anthropic")?.selection, manual);
  const failedWho = parts(failure); failedWho.who.code = 2;
  assert.equal(accountsView("thread", { ...failedWho, at: 0 }, null).providers[0]?.resolution?.error, failure.error);
  assert.deepEqual(parsePoolSelection({ mode: "auto" }), { mode: "auto" });
  assert.throws(() => parsePoolSelection({ mode: "manual" }), /invalid account selection/);
  assert.throws(() => parsePoolSelection(undefined), /invalid account selection/);
});

test("manual Off can run while Auto eligibility stays false, and a real manual error still holds", () => {
  assert.equal(poolAdmitsNow(parts({ selection: manual, account: off.id }), "anthropic", 0), true);
  assert.equal(poolAdmitsNow(parts({ selection: { mode: "auto" }, account: off.id }), "anthropic", 0), false);
  assert.equal(poolAdmitsNow(parts({ selection: manual, account: off.id, error: "Account is limited" }), "anthropic", 0), false);
});

test("the new-chat picker renders Off as an enabled manual option and keeps Auto separate", async () => {
  const target = join(dir, "picker.mjs");
  await symlink(join(import.meta.dirname, "../node_modules"), join(dir, "node_modules"), "dir");
  const plugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;
  await build({ stdin: { contents: `export {default} from "./AccountPicker.svelte"; export {resolutionSentence, resolvedAccount, isManualAccount} from "./accounts.ts";`, resolveDir: join(import.meta.dirname, "../src/client"), loader: "ts" }, outfile: target, bundle: true, platform: "node", format: "esm", packages: "external",
    plugins: [{ name: "no-browser-api", setup(build) { build.onResolve({ filter: /^\.\/api\.ts$/ }, () => ({ path: "api", namespace: "test" })); build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const api = {};" })); } },
      plugin({ compilerOptions: { generate: "server", runes: true, css: "external" } })] });
  const { default: Picker, resolutionSentence, resolvedAccount, isManualAccount } = await import(pathToFileURL(target).href);
  const provider = accountsView(null, { ...parts({ selection: { mode: "auto" }, account: "auto-account" }), at: 0 }, null).providers[0]!;
  const html = render(Picker, { props: { provider, choice: null, onchoose: () => {} } }).body;
  assert.match(html, />Auto</);
  assert.match(html, /Manual/);
  assert.match(html, /off@example.invalid/);
  assert.match(html, />Off</);
  assert.doesNotMatch(html, /aria-disabled="true"|\sdisabled(?:=|\s|>)/);
  const blocked = accountsView("thread", { ...parts({ selection: manual, account: "auto-account", error: "The chosen sign-in expired", wait: { account: off.id, slot_at: 120 } }), at: 0 }, null).providers[0]!;
  assert.equal(resolvedAccount(blocked)?.id, off.id, "a different resolved account must never replace the intended manual target");
  assert.equal(isManualAccount(blocked, off.id), true);
  assert.match(resolutionSentence(blocked, 0), /Manual keeps off@example.invalid selected for this thread\. The chosen sign-in expired Admission waits until/);
  const missing = { ...blocked, rows: [] };
  assert.equal(resolvedAccount(missing), undefined);
  assert.match(resolutionSentence(missing, 0), /Manual keeps off-account selected/);
});

test("a fresh new chat pins Off before its first prompt, then Auto clears the existing thread binding", async t => {
  const prompts: string[] = [], retries: string[] = [];
  const backend = {
    close: async () => {}, catalog: { isOtherHost: () => false, selfHost: () => null },
    threads: { create: async () => ({ id: "new-thread" }), prompt: async (id: string) => { prompts.push(JSON.parse(await readFile(state, "utf8"))[id]); }, archive: async () => assert.fail("a known Off account must not be archived") },
    created: { add: async () => {} }, newChat: { remember: async () => {} }, chats: { retryNow: async (id: string) => { retries.push(id); } },
  } as unknown as ChatBackend;
  const empty = asset(Buffer.from(""), "text/plain");
  const server = await startChatServer({ backend, bundle: { js: empty, css: empty, version: "manual-off" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "manual-off", socketPath: join(dir, "no-daemon.sock") }, onStop: async () => {} });
  t.after(() => server.close());
  const post = async (route: string, body: unknown) => {
    const response = await fetch(new URL(route, server.url), { method: "POST", headers: { "content-type": "application/json", "x-chat-token": "token", origin: new URL(server.url).origin }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  await post("api/threads", { requestId: "manual-off-new-chat", cwd: dir, provider: "anthropic", message: "manual Off regression", account: { provider: "anthropic", id: "off-account" } });
  assert.deepEqual(prompts, ["off-account"]);
  const followed = await post("api/accounts", { action: "follow", provider: "anthropic", id: "new-thread" });
  assert.deepEqual(followed.providers[0].resolution.selection, { mode: "auto" });
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {});
  const picked = await post("api/accounts", { action: "use", provider: "anthropic", account: "off-account", id: "new-thread" });
  assert.deepEqual(picked.providers[0].resolution.selection, manual);
  assert.equal(picked.providers[0].rows[0].disabled, true);
  assert.equal(picked.providers[0].rows[0].usable, false);
  assert.deepEqual(retries, ["new-thread", "new-thread"]);
});
