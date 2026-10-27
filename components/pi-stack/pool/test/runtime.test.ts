import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { openRuntime } from "../../test/faux.ts";
import { createPoolExtension } from "../index.ts";
import { fakeAnthropic, openAnthropic, rateLimited, type Answer } from "../check/rig.ts";

const FAKE = fileURLToPath(new URL("./fake-pool.mjs", import.meta.url));
let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "pi-pool-rt-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

interface Rig { dir: string; calls(): { argv: string[]; key: string | null; protocol: string | null }[] }

/** A fresh fake pool and a runtime on a built-in Anthropic model that talks to a fake server. */
async function rig(name: string, state: Record<string, unknown>, answers: Answer[]) {
  const dir = join(root, name);
  mkdirSync(join(dir, "pool"), { recursive: true });
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ retry: { baseDelayMs: 50 } }));
  writeFileSync(join(dir, "pool", "state.json"), JSON.stringify({ accounts: ["A", "B"], current: 0, ...state }));
  writeFileSync(join(dir, "pool", "turns.json"), "{}");
  process.env.FAKE_POOL_DIR = join(dir, "pool");
  const server = await fakeAnthropic(answers);
  const ext = createPoolExtension({ bin: FAKE, turnsFile: join(dir, "pool", "turns.json"), agentDir: join(dir, "agent") });
  const rt = await openAnthropic(dir, server.url, [ext]);
  const pool: Rig = {
    dir,
    calls: () => readFileSync(join(dir, "pool", "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
  return { rt, server, pool };
}

test("each request carries the token the pool vends for this session's tree", async () => {
  const { rt, server, pool } = await rig("vend", {}, [{ status: 200, text: "one" }]);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "one");
  assert.equal(server.seen.length, 1);
  assert.equal(server.seen[0].authorization, "Bearer sk-ant-oat01-A");
  assert.equal(server.seen[0].apiKey, undefined);
  assert.match(server.seen[0].beta ?? "", /oauth-2025-04-20/);
  assert.match(server.seen[0].system, /You are a general purpose agent that uses code to solve tasks/);
  assert.doesNotMatch(server.seen[0].system, /expert coding assistant/);
  const sid = rt.session.sessionManager.getSessionId();
  const vend = pool.calls().find(c => c.argv[0] === "--provider");
  assert.deepEqual(JSON.parse(vend!.key!), { key: sid, uuid: sid, active: sid });
  assert.equal(vend!.protocol, "1");
  await rt.dispose();
  await server.close();
});

test("a slot wait holds the request until the slot, then sends it", async () => {
  const waitUntil = Date.now() / 1000 + 2.5;
  const { rt, server } = await rig("slot", { waitUntil }, [{ status: 200, text: "after the slot" }]);
  const started = Date.now();
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "after the slot");
  assert.ok(server.seen[0].at >= waitUntil * 1000, `sent at ${server.seen[0].at - started} ms`);
  await rt.dispose();
  await server.close();
});

test("an abort ends a slot wait at once and sends nothing", async () => {
  const { rt, server, pool } = await rig("abort", { waitUntil: Date.now() / 1000 + 3600 }, []);
  const started = Date.now();
  const prompt = rt.session.prompt("hi");
  setTimeout(() => void rt.session.abort(), 800);
  await prompt;
  const last = rt.session.messages.at(-1) as { stopReason?: string };
  assert.equal(last.stopReason, "aborted");
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(server.seen.length, 0);
  assert.ok(pool.calls().some(c => c.argv[0] === "--cli" && c.argv[1] === "release"), "the queue slot was released");
  await rt.dispose();
  await server.close();
});

test("a 429 moves the turn to the pool's next account", async () => {
  const { rt, server, pool } = await rig("swap", {}, [rateLimited(3600), { status: 200, text: "from B" }]);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "from B");
  assert.deepEqual(server.seen.map(s => [s.status, s.authorization]), [[429, "Bearer sk-ant-oat01-A"], [200, "Bearer sk-ant-oat01-B"]]);
  const limited = pool.calls().find(c => c.argv[1] === "limited");
  assert.ok(limited, "the 429 was reported");
  const until = Number(limited!.argv[limited!.argv.indexOf("--until") + 1]);
  // Pi 1.4.0 keeps no response headers on a failed message, so with no "Server requested" lead the pool marks 5 minutes.
  assert.ok(Math.abs(until - (Date.now() / 1000 + 300)) < 30, `until ${until}`);
  await rt.dispose();
  await server.close();
});

test("a 429 with no free account waits for the session's slot, then retries", async () => {
  const { rt, server } = await rig("last", { accounts: ["A"], slotAfterSec: 2 }, [rateLimited(), { status: 200, text: "after the wait" }]);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "after the wait");
  assert.equal(server.seen.length, 2);
  assert.ok(server.seen[1].at - server.seen[0].at >= 1500, `retried after ${server.seen[1].at - server.seen[0].at} ms`);
  await rt.dispose();
  await server.close();
});

test("a hook that gives no token retries the turn with a new hook run", async () => {
  const { rt, server } = await rig("nohook", { failTimes: 3 }, [{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid bearer token" } } }, { status: 200, text: "second try" }]);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "second try");
  assert.deepEqual(server.seen.map(s => s.authorization), ["Bearer pi-pool-gave-no-token", "Bearer sk-ant-oat01-A"]);
  await rt.dispose();
  await server.close();
});

test("a queued run waits for its working slot and gives it back at agent_end and shutdown", async () => {
  const { rt, server, pool } = await rig("queue", { queuedTimes: 1 }, [{ status: 200, text: "admitted" }]);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "admitted");
  const sid = rt.session.sessionManager.getSessionId();
  const verbs = pool.calls().filter(c => c.argv[0] === "--cli").map(c => c.argv.slice(1, 3).join(" "));
  assert.ok(verbs.filter(v => v === `admit ${sid}`).length >= 2, verbs.join(", "));
  assert.ok(verbs.includes(`release ${sid}`), verbs.join(", "));
  const entries = rt.session.sessionManager.getEntries().filter(e => e.type === "custom");
  assert.equal(entries.length, 1);
  await rt.dispose();
  const after = pool.calls().filter(c => c.argv[0] === "--cli").map(c => c.argv.slice(1).join(" "));
  assert.ok(after.includes(`model --clear --source ${sid}`), after.join(", "));
  await server.close();
});

test("openai-codex vends in the stream wrapper and a 429 moves it to the next account", async () => {
  const dir = join(root, "codex");
  mkdirSync(join(dir, "pool"), { recursive: true });
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ retry: { baseDelayMs: 50 } }));
  writeFileSync(join(dir, "pool", "state.json"), JSON.stringify({ accounts: ["A", "B"], current: 0 }));
  writeFileSync(join(dir, "pool", "turns.json"), "{}");
  process.env.FAKE_POOL_DIR = join(dir, "pool");
  const keys: (string | undefined)[] = [];
  const codex = {
    streamSimple: (model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
      keys.push(options?.apiKey);
      const out = createAssistantMessageEventStream();
      const base = { role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
      queueMicrotask(() => {
        if (keys.length === 1) {
          const error = { ...base, stopReason: "error" as const, errorMessage: "429 You have hit your ChatGPT usage limit" };
          out.push({ type: "error", reason: "error", error });
          out.end(error);
          return;
        }
        const message = { ...base, content: [{ type: "text" as const, text: "codex ok" }], stopReason: "stop" as const };
        out.push({ type: "done", reason: "stop", message });
        out.end(message);
      });
      return out;
    },
  };
  const ext = createPoolExtension({ bin: FAKE, turnsFile: join(dir, "pool", "turns.json"), agentDir: join(dir, "agent"), codex });
  const rt = await openRuntime({ root: dir, extensionFactories: [ext] });
  const model = rt.services.modelRuntime.getModel("openai-codex", "gpt-6-sol");
  assert.ok(model);
  await rt.session.setModel(model);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "codex ok");
  assert.deepEqual(keys, ["codex-token-A", "codex-token-B"]);
  await rt.dispose();
});

test("a session on a provider outside the pool never enters the turn queue or vends", async () => {
  const dir = join(root, "faux");
  mkdirSync(join(dir, "pool"), { recursive: true });
  writeFileSync(join(dir, "pool", "state.json"), JSON.stringify({ accounts: ["A"], current: 0, queuedTimes: 100 }));
  writeFileSync(join(dir, "pool", "turns.json"), "{}");
  process.env.FAKE_POOL_DIR = join(dir, "pool");
  const ext = createPoolExtension({ bin: FAKE, turnsFile: join(dir, "pool", "turns.json"), agentDir: join(dir, "agent") });
  const rt = await openRuntime({ root: dir, extensionFactories: [ext] });
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "faux reply");
  const calls = readFileSync(join(dir, "pool", "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { argv: string[] });
  assert.deepEqual(calls.filter(c => c.argv[0] === "--provider" || ["admit", "release"].includes(c.argv[1])), []);
  await rt.dispose();
});
