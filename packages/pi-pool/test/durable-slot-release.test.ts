/**
 * A durable run that meets an account slot wait lets its working slot in the turn queue go, as a Prime run does, and asks
 * again when the slot opens. On 11-03 pi-host runs kept their slots through account waits: at 08:25Z 20 of us-metal02's 40
 * working slots sat in pi-host account waits while other runs queued. The queue here is the real pool/turns.py in its own
 * PI_POOL_DIR with working_max 1; a stand-in hook answers token requests with a slot wait until `until`, then a token.
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
import { createRegistry, Harness, type LiveState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { durableSettings, poolProvider, TurnQueue } from "../src/durable/pool-provider.ts";

const context = BACKGROUND_CONTEXT;
const POOL_CLI = fileURLToPath(new URL("../bin/pi-pool", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-pool-durable-slot-release-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const poolDir = join(dir, "pool");
mkdirSync(poolDir);
process.env.PI_POOL_DIR = poolDir;
const untilFile = join(dir, "until");
const hook = join(dir, "pool-hook");
writeFileSync(hook, `#!/bin/sh
if [ "$1" = "--cli" ]; then shift; exec /usr/bin/python3 -B '${POOL_CLI}' "$@"; fi
until=$(cat '${untilFile}')
if [ "$(date +%s)" -lt "$until" ]; then printf '{"retryAt": %s, "message": "waiting for an account slot"}' "$until"; exit 75; fi
printf 'sk-ant-oat01-faux'
`);
chmodSync(hook, 0o755);

const poolRun = (...args: string[]) => execFileSync("/usr/bin/python3", ["-B", POOL_CLI, ...args], { encoding: "utf8" });
const pool = (...args: string[]) => JSON.parse(poolRun(...args).trim().split("\n").at(-1)!) as Record<string, unknown>;
const log = () => readFileSync(join(poolDir, "pi-pool.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event?: string; session?: string; kind?: string });

test("a run in an account slot wait holds no working slot, and the next run takes it meanwhile", async () => {
  poolRun("set", "agent_queue_on", "1");
  poolRun("set", "working_max", "1");
  writeFileSync(untilFile, String(Math.ceil(Date.now() / 1000) + 4));
  const treeKey = "pi-durable:slot-release";
  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-5-5" }], tokensPerSecond: 0 });
  faux.setResponses([fauxAssistantMessage("answered")]);
  const models = createModels();
  models.setProvider(poolProvider({ treeKey, bin: hook, inner: faux.provider, turns: new TurnQueue({ bin: hook }) }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "thread.sqlite")), { models, registry: createRegistry(), settings: durableSettings(treeKey, { baseDelayMs: 5, maxAgentDelayMs: 20 }) }, context);
  harness.resume();
  const root = await harness.root(context, { agent: { model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "off" } });
  const watch = await root.watch(context);
  const sleeping = new Promise<void>(resolve => watch.start(async value => {
    if ((value.docs["pi.live"] as LiveState | undefined)?.generation?.deferred) resolve();
  }));
  const submission = await root.submit({ type: "input", content: "hello", requestId: "slot-release-1" }, context);
  await sleeping;
  await watch.stop();

  const admitted = log().find(line => line.event === "turn_admitted");
  assert.ok(admitted?.session, "the run took a working slot before it asked for a token");
  const session = admitted.session;
  assert.ok(log().some(line => line.event === "turn_released" && line.session === session), JSON.stringify(log().slice(-6)));
  const queue = pool("queue", "--json") as { working: { session: string }[] };
  assert.deepEqual(queue.working.map(w => w.session), [], "the run in the slot wait holds no working slot");
  assert.equal(pool("admit", "other-run", "--pid", String(process.pid), "--tree", "other").state, "admitted", "another run takes the freed slot");
  pool("release", "other-run");

  const settled = await submission.wait(context);
  await harness.waitForIdle(context);
  assert.equal(settled.status, "done");
  assert.ok(Date.now() / 1000 >= Number(readFileSync(untilFile, "utf8")), "the request ran after the slot opened");
  assert.equal(log().filter(line => line.event === "turn_admitted" && line.session === session).length, 2, "the retry asked for a working slot again");
  await harness.close(context);
});
