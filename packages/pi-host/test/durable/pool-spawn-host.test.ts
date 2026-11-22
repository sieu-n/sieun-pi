/**
 * pi-host runs pi-pool's token hook from the spawn host's small process (legacy/prime/user-history/src/spawn-host.ts), never by a fork of its
 * own. On 11-22 on us-metal02 pi-host forked about one hook a second from its 1 GB process, and each fork held its main thread 50 to 290 ms
 * (on CPU, then blocked until the child's exec), 49 of the 70 reads over 50 ms in 300 s (~/work/thread-reads/loop/sched-5.json).
 *
 * The stand-in hook writes its parent's pid and runs the real pi-pool CLI for `--cli` calls in its own PI_POOL_DIR, so the queue is real:
 * 1. Pool calls run with the spawn host as their parent, and an admit names pi-host's pid, so the queue's "process gone" sweep still
 *    follows pi-host.
 * 2. An admit still running when the run's input settles, as after an abort (main.ts `inputSettled`), leaves no place in the queue.
 * 3. An aborted vend answers at once, and the hook that finishes later holds no place in the queue.
 * 4. A vend whose spawn host dies mid-call ends that request with a retryable error, and the retry vends again and answers.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { durableSettings, poolProvider, TurnQueue } from "@sieun-pi/pi-pool/durable";
import { poolEnv, vendOnce } from "@sieun-pi/pi-pool/pool-cli";
import { hostExecFile, stopSpawnHost } from "../../../../legacy/prime/user-history/src/spawn-host.ts";
import { MODEL } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const POOL_CLI = fileURLToPath(new URL("../../../pi-pool/bin/pi-pool", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-host-pool-spawn-"));
after(() => {
  stopSpawnHost();
  rmSync(dir, { recursive: true, force: true });
});
const poolDir = join(dir, "pool");
mkdirSync(poolDir);
process.env.PI_POOL_DIR = poolDir;
const parents = join(dir, "parents");
const slowAdmit = join(dir, "slow-admit");
const slowVend = join(dir, "slow-vend");
const hook = join(dir, "pool-hook");
writeFileSync(hook, `#!/bin/sh
echo "$PPID $1 $2" >> '${parents}'
if [ "$1" = "--cli" ]; then
  if [ "$2" = "admit" ] && [ -f '${slowAdmit}' ]; then sleep 1; fi
  shift; exec /usr/bin/python3 -B '${POOL_CLI}' "$@"
fi
if [ -f '${slowVend}' ]; then rm -f '${slowVend}'; sleep 1; fi
printf 'sk-ant-oat01-faux'
`);
chmodSync(hook, 0o755);
const calls = () => readFileSync(parents, "utf8").trim().split("\n").map(line => {
  const [ppid, ...args] = line.split(" ");
  return { ppid: Number(ppid), args: args.join(" ") };
});
const pool = (...args: string[]) => execFileSync("/usr/bin/python3", ["-B", POOL_CLI, ...args], { encoding: "utf8" });
/** Every session the queue holds, working or queued, with the pid it follows. */
const placed = () => {
  const turns = JSON.parse(readFileSync(join(poolDir, "turns.json"), "utf8")) as { working?: Record<string, { pid?: number }>; queued?: Record<string, { pid?: number }> };
  return { ...turns.queued, ...turns.working };
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("the turn queue's pool calls and a request's token vend run from the spawn host, and an admit names pi-host's pid", async () => {
  pool("set", "agent_queue_on", "1");
  pool("set", "working_max", "4");
  const turns = new TurnQueue({ bin: hook, exec: hostExecFile });
  assert.equal(await turns.lead("add", "comm-session"), true, "the lead call reads the hook's exit 0");
  const key = { root: "pi-durable:spawn", session: "spawn-run" };
  assert.deepEqual(await turns.enter(key), { kind: "go" });

  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-5-5" }], tokensPerSecond: 0 });
  faux.setResponses([fauxAssistantMessage("answered")]);
  const provider = poolProvider({ treeKey: "pi-durable:pool-spawn", bin: hook, inner: faux.provider, exec: hostExecFile });
  const model = provider.getModels().find(m => m.id === "claude-opus-5-5")!;
  const answer = await provider.stream(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never, {}).result();
  assert.equal(answer.stopReason, "stop", JSON.stringify(answer));

  const seen = calls();
  assert.deepEqual(seen.map(c => c.args), ["--cli lead", "--cli admit", "--provider anthropic"]);
  for (const call of seen) assert.notEqual(call.ppid, process.pid, `${call.args} ran as a child of pi-host's own process`);
  assert.equal(placed()["spawn-run"]?.pid, process.pid, "the working slot follows pi-host's pid, not the spawn host's");
  await turns.release(key);
  assert.equal(placed()["spawn-run"], undefined);
});

test("an admit still running when the run's input settles, as after an abort, leaves no place in the queue", async () => {
  const turns = new TurnQueue({ bin: hook, exec: hostExecFile });
  const key = { root: "pi-durable:abort", session: "aborted-run" };
  writeFileSync(slowAdmit, "");
  try {
    const entering = turns.enter(key);
    await sleep(300);
    // main.ts gives the slot back from `inputSettled`, which an aborted input reaches while its admit is still in the hook.
    await turns.release(key);
    assert.deepEqual(await entering, { kind: "go" }, "the late admit still answers");
  } finally {
    rmSync(slowAdmit, { force: true });
  }
  assert.equal(placed()["aborted-run"], undefined, `the queue holds ${JSON.stringify(placed())}`);
  assert.equal(turns.holds("aborted-run"), false);
});

test("an aborted vend answers at once, and the hook that finishes later holds no place in the queue", async () => {
  writeFileSync(slowVend, "");
  const abort = new AbortController();
  const started = Date.now();
  const vending = vendOnce(hook, "anthropic", poolEnv({ root: "pi-durable:vend", session: "vend-run" }, undefined), abort.signal, MODEL.modelId, hostExecFile);
  await sleep(200);
  abort.abort();
  const got = await vending;
  assert.equal(got.kind, "failed");
  assert.ok(Date.now() - started < 800, `the abort answered after ${Date.now() - started} ms`);
  await sleep(1200);
  assert.equal(placed()["vend-run"], undefined);
});

test("a vend whose spawn host dies mid-call fails that request with a retryable error, and the retry vends again and answers", async () => {
  writeFileSync(slowVend, "");
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let sent = 0;
  faux.setResponses([() => { sent++; return fauxAssistantMessage("The answer after the helper came back."); }]);
  const models = createModels();
  models.setProvider(poolProvider({ treeKey: "pi-durable:helper-died", bin: hook, inner: faux.provider, exec: hostExecFile }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "helper-died.sqlite")), { models, registry: createRegistry(), settings: durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }) }, context);
  harness.resume();
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  const submission = await root.submit({ type: "input", content: "hello" }, context);
  await sleep(400);
  stopSpawnHost();
  const settled = await submission.wait(context);
  const messages = [...(await root.entries({ order: "ascending" }, 100, undefined, context)).items].flatMap(entry => entry.model ?? []);
  await harness.close(context);
  assert.equal(settled.status, "done");
  assert.equal(sent, 1, "the failed vend sent nothing, and the retry sent the one request");
  const failed = messages.filter(message => message.role === "assistant" && message.stopReason === "error");
  assert.equal(failed.length, 1);
  assert.match(String("errorMessage" in failed[0]! ? failed[0].errorMessage : ""), /gave no token \(spawn host stopped\)/);
});
