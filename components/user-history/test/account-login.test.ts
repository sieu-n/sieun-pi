// 2026-10-19: a cross-device callback paste retried into a cleared sign-in form.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AccountLogins, parseLoginEvent, PoolError } from "../src/chat-pool.ts";
import type { AccountLogin } from "../src/shared/types.ts";

const callback = "http://localhost:53692/callback?code=test%2Bcode%2Fvalue&state=test-state";
const authorization = {
  event: "url", url: "https://provider.example/authorize?state=test-state",
  manual_url: "https://provider.example/manual?state=test-state", paste: true,
};

async function fixture(t: TestContext): Promise<{ logins: AccountLogins; received: () => Promise<string>; args: () => Promise<string[]> }> {
  const scratch = join(homedir(), "scratch", "p13-pasted-oauth");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "account-login-"));
  const executable = join(directory, "fake-pool.mjs");
  const input = join(directory, "stdin.txt");
  const argumentsPath = join(directory, "argv.json");
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
emit(${JSON.stringify(authorization)});
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  appendFileSync(${JSON.stringify(input)}, line + "\\n");
  if (line !== ${JSON.stringify(callback)}) emit({ event: "retry", message: "That URL has the wrong state. Paste the matching URL or code." });
  else { emit({ event: "done", ok: true, message: "Saved the test account." }); lines.close(); process.stdin.destroy(); }
});
`, { mode: 0o700 });
  const logins = new AccountLogins({ executable });
  t.after(async () => { await logins.close(); await rm(directory, { recursive: true, force: true }); });
  return { logins, received: () => readFile(input, "utf8"), args: async () => JSON.parse(await readFile(argumentsPath, "utf8")) };
}

function until(logins: AccountLogins, predicate: (login: AccountLogin) => boolean): Promise<AccountLogin> {
  return new Promise(resolve => {
    const stop = logins.subscribe(login => {
      if (login && predicate(login)) { queueMicrotask(() => stop()); resolve(login); }
    });
  });
}

test("a pasted full callback URL reaches pi-pool stdin unchanged and cannot be reused after done", async t => {
  const { logins, received } = await fixture(t);
  const started = logins.start("anthropic", null);
  await until(logins, login => login.status === "waiting");
  assert.equal(logins.paste(started.id, callback).status, "finishing");
  const done = await until(logins, login => login.status === "done");
  assert.equal(await received(), callback + "\n");
  assert.equal(done.message, "Saved the test account.");
  assert.throws(() => logins.paste(started.id, callback), error => error instanceof PoolError && error.status === 404 && error.message === "This sign-in has ended.");
});

test("a rejected paste keeps the same authorization flow actionable across consumer reconnects", async t => {
  const { logins, received } = await fixture(t);
  const firstConsumer: (AccountLogin | null)[] = [];
  const disconnect = logins.subscribe(login => firstConsumer.push(login));
  const started = logins.start("anthropic", null);
  const waiting = await until(logins, login => login.status === "waiting");
  const wrong = callback.replace("test-state", "wrong-state");
  logins.paste(started.id, wrong);
  const retry = await until(logins, login => login.message !== null);
  assert.equal(retry.status, "waiting");
  assert.equal(retry.id, started.id);
  assert.equal(retry.url, waiting.url);
  assert.equal(retry.manualUrl, waiting.manualUrl);
  assert.equal(retry.code, waiting.code);
  assert.equal(retry.paste, true);
  assert.ok(retry.message);
  assert.match(retry.message, /wrong state/);
  assert.equal(firstConsumer.at(-1), retry);
  disconnect();
  const reconnected: (AccountLogin | null)[] = [];
  const unsubscribe = logins.subscribe(login => reconnected.push(login));
  t.after(unsubscribe);
  assert.deepEqual(reconnected, [retry]);
  logins.paste(started.id, callback);
  const done = await until(logins, login => login.status === "done");
  assert.equal(reconnected.at(-1), done);
  assert.equal(firstConsumer.at(-1), retry);
  assert.equal(await received(), wrong + "\n" + callback + "\n");
  const afterDone: (AccountLogin | null)[] = [];
  logins.subscribe(login => afterDone.push(login))();
  assert.deepEqual(afterDone, [done]);
});

test("retry fallback tells the consumer to paste a URL or code without claiming there is a new link", () => {
  assert.deepEqual(parseLoginEvent('{"event":"retry"}'), {
    event: "retry", message: "That URL or code was not accepted. Paste the matching callback URL or code and try again.",
  });
});


test("a reserved login forwards Off before its account can be published", async t => {
  const { logins, args } = await fixture(t);
  const started = logins.start("anthropic", null, true);
  await until(logins, login => login.status === "waiting");
  const argv = await args();
  assert.equal(argv[0], "login");
  assert.ok(argv.includes("--off"));
  logins.paste(started.id, callback);
  await until(logins, login => login.status === "done");
});
