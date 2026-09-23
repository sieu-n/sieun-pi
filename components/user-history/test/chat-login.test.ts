import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountLogins, parseLoginEvent, poolCommand } from "../src/chat-pool.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import type { AccountLogin } from "../src/shared/types.ts";

/** A fake pi-pool: records its argv, then plays the login contract. Claude takes pasted codes ("bad" is refused once); Codex shows a device code and never ends on its own. */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
const say = event => process.stdout.write(JSON.stringify(event) + "\\n");
const provider = process.argv[process.argv.indexOf("--provider") + 1];
if (process.env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
if (provider === "openai-codex") {
  say({ event: "url", url: "https://auth.openai.com/codex/device", manual_url: null, code: "ABCD-EFGH", paste: false });
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => { if (!process.env.FAKE_IGNORE_TERM) { say({ event: "done", ok: false, message: "cancelled" }); process.exit(1); } });
  setInterval(() => {}, 1000);
} else {
  say({ event: "url", url: "javascript:alert(1)", manual_url: "https://claude.ai/oauth/authorize?state=1", code: null, paste: true });
  let buffer = "";
  process.stdin.setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    for (const line of buffer.split("\\n").slice(0, -1)) {
      if (line === "bad") { say({ event: "retry", message: "That code was not accepted." }); say({ event: "url", url: "https://claude.ai/oauth/authorize?state=2", manual_url: "https://claude.ai/oauth/authorize?state=2", code: null, paste: true }); }
      else { say({ event: "done", ok: true, message: "added new@x" }); process.exit(0); }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
  });
  process.stdin.on("end", () => { say({ event: "done", ok: false, message: "cancelled" }); process.exit(1); });
}
`;

function fixture(): { dir: string; executable: string; args: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "chat-login-"));
  const executable = join(dir, "pi-pool");
  writeFileSync(executable, FAKE.replace("#!/usr/bin/env node", "#!" + process.execPath));
  chmodSync(executable, 0o755);
  process.env.FAKE_ARGS = join(dir, "args.json");
  return { dir, executable, args: () => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[] };
}

function until(logins: AccountLogins, done: (login: AccountLogin) => boolean, ms = 5000): Promise<AccountLogin> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("timed out at " + JSON.stringify(logins.current()))); }, ms);
    const stop = logins.subscribe(login => { if (login && done(login)) { clearTimeout(timer); queueMicrotask(stop); resolve(login); } });
  });
}

test("the adapter holds the exact pi-pool command lines", () => {
  assert.deepEqual(poolCommand.disable("anthropic", "a@x"), ["off", "a@x", "--provider", "anthropic"]);
  assert.deepEqual(poolCommand.enable("openai-codex", "c@x"), ["on", "c@x", "--provider", "openai-codex"]);
  assert.deepEqual(poolCommand.remove("anthropic", "a@x"), ["rm", "a@x", "--provider", "anthropic"]);
  assert.deepEqual(poolCommand.login("anthropic", null, 600), ["login", "--provider", "anthropic", "--timeout", "600"]);
  assert.deepEqual(poolCommand.login("anthropic", "a@x", 600), ["login", "a@x", "--provider", "anthropic", "--timeout", "600"]);
});

test("login events parse at the boundary and drop links that are not https", () => {
  assert.deepEqual(parseLoginEvent('{"event":"url","url":"http://evil","manual_url":"https://claude.ai/x","code":null,"paste":true}'),
    { event: "url", url: null, manualUrl: "https://claude.ai/x", code: null, paste: true });
  assert.deepEqual(parseLoginEvent('{"event":"done","ok":true,"message":"added a@x"}'), { event: "done", ok: true, message: "added a@x" });
  assert.equal(parseLoginEvent("Starting claude"), null);
  assert.equal(parseLoginEvent('{"event":"other"}'), null);
});

test("a Claude login takes a pasted code, survives a refused one, and ends done", async () => {
  const { dir, executable, args } = fixture();
  const logins = new AccountLogins({ executable, deadlineMs: 20_000, graceMs: 500 });
  try {
    const started = logins.start("anthropic", null);
    assert.equal(started.status, "starting");
    assert.throws(() => logins.start("openai-codex", null), /still running/);
    const waiting = await until(logins, login => login.status === "waiting");
    assert.equal(waiting.url, "https://claude.ai/oauth/authorize?state=1", "a non-https link falls back to the manual link");
    assert.equal(waiting.paste, true);
    assert.deepEqual(args(), ["login", "--provider", "anthropic", "--timeout", "20"]);
    assert.equal(logins.paste(started.id, "bad").status, "finishing");
    const again = await until(logins, login => login.status === "waiting" && login.url?.endsWith("state=2") === true);
    assert.equal(again.message, null);
    assert.throws(() => logins.paste(started.id, "two\nlines"), /one line/);
    logins.paste(started.id, "good-code");
    const done = await until(logins, login => login.status === "done");
    assert.equal(done.message, "added new@x");
    assert.throws(() => logins.cancel(started.id), /has ended/);
  } finally { await logins.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a Codex sign-in again shows the device code and cancels by closing stdin", async () => {
  const { dir, executable, args } = fixture();
  const logins = new AccountLogins({ executable, deadlineMs: 20_000, graceMs: 500 });
  try {
    const started = logins.start("openai-codex", "c@x");
    const waiting = await until(logins, login => login.status === "waiting");
    assert.equal(waiting.code, "ABCD-EFGH");
    assert.equal(waiting.account, "c@x");
    assert.deepEqual(args(), ["login", "c@x", "--provider", "openai-codex", "--timeout", "20"]);
    assert.throws(() => logins.paste(started.id, "x"), /does not take a pasted code/);
    logins.cancel(started.id);
    assert.equal((await until(logins, login => login.status === "cancelled")).message, null);
  } finally { await logins.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the deadline kills a login that ignores stdin and SIGTERM", async () => {
  const { dir, executable } = fixture();
  process.env.FAKE_IGNORE_TERM = "1";
  const logins = new AccountLogins({ executable, deadlineMs: 400, graceMs: 200 });
  try {
    logins.start("openai-codex", null);
    const failed = await until(logins, login => login.status === "failed");
    assert.match(failed.message ?? "", /did not finish in 1 min/);
    assert.throws(() => logins.start("anthropic", "-x"), /Choose an account/);
  } finally { delete process.env.FAKE_IGNORE_TERM; await logins.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("login routes stream state and need the page token and origin", async () => {
  const { dir, executable } = fixture();
  const logins = new AccountLogins({ executable, deadlineMs: 20_000, graceMs: 500 });
  const backend = { close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {}, logins });
  const origin = new URL(server.url).origin;
  const post = (route: string, body: unknown, headers: Record<string, string> = { "X-Chat-Token": "token", Origin: origin }) =>
    fetch(server.url + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const events = new AbortController();
  try {
    assert.equal((await post("api/accounts/login", { provider: "anthropic" }, { Origin: origin })).status, 403);
    assert.equal((await post("api/accounts/login", { provider: "anthropic" }, { "X-Chat-Token": "token", Origin: "http://evil.example" })).status, 403);
    assert.equal((await post("api/accounts/login", { provider: "gemini" })).status, 400);
    const stream = await fetch(server.url + "api/accounts/login/stream", { signal: events.signal });
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    const read = async (pattern: RegExp) => { while (!pattern.test(seen)) { const { value, done } = await reader.read(); if (done) throw new Error(seen); seen += value; } };
    await read(/event: login\ndata: null/);
    const started = await (await post("api/accounts/login", { provider: "anthropic" })).json() as AccountLogin;
    assert.equal((await post("api/accounts/login", { provider: "openai-codex" })).status, 409);
    await read(/"status":"waiting"/);
    assert.equal((await post("api/accounts/login/paste", { id: "other", code: "x" })).status, 404);
    assert.equal((await post("api/accounts/login/paste", { id: started.id, code: "good" })).status, 200);
    await read(/"status":"done"/);
  } finally { events.abort(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
