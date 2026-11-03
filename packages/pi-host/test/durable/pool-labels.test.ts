/**
 * pi-host labels an agent's threads to pi-pool as the chat service labels a Prime chat (`pool-labels.ts`):
 * 1. `threadClass` gives the agent's threads Prime's classes, and `PoolLabels` asks the pool once per tree, runs its calls in order and
 *    tries a failed class again at the next open.
 * 2. On DurableThreads with the real pool/turns.py queue in its own PI_POOL_DIR and the faux model: a comm thread's run asks in its work
 *    thread's tree, the work tree is high, the comm thread's root session is on the lead list while its file is open, and the chat
 *    service's lead writer (`leadWriter` in legacy/prime/user-history/src/chat-hosts.ts), which replaces the list, keeps that id while it
 *    writes its own chat heads, and keeps them after pi-host drops its id.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableSettings, poolProvider, TurnQueue, type PoolClass } from "@sieun-pi/pi-pool/durable";
import { leadWriter } from "../../../../legacy/prime/user-history/src/chat-hosts.ts";
import type { AgentRef } from "../../src/durable/agent-profile.ts";
import { PoolLabels, threadClass, type PoolLabelCalls } from "../../src/durable/pool-labels.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { fauxRespond, MODEL, PLAIN_INPUT } from "./crash-scenario.ts";

const here = dirname(fileURLToPath(import.meta.url));
const POOL_CLI = join(here, "..", "..", "..", "pi-pool", "bin", "pi-pool");
const scratch = mkdtempSync(join(tmpdir(), "pi-host-pool-labels-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const dir = "/tmp/agents/vent";
const work: AgentRef = { agent: "ag_vent", dir, role: "work", comm: "C" };
const comm = (room: string): AgentRef => ({ agent: "ag_vent", dir, role: "comm", room, work: "W" });

test("threadClass gives a work thread, a comm thread and a job high, a duty job low, a check-in or Wiki dream duty job normal, and no agent nothing", () => {
  assert.equal(threadClass(work, "vent"), "high");
  assert.equal(threadClass(comm("dm_vent"), "vent · DM"), "high");
  assert.equal(threadClass({ agent: "ag_vent", dir, role: "job" }, "relay page job"), "high");
  assert.equal(threadClass({ agent: "ag_vent", dir, role: "job" }, "Uptime sweep duty 261103-190500"), "low");
  assert.equal(threadClass({ agent: "ag_vent", dir, role: "job" }, "Check-in duty 261103-190500"), "normal");
  assert.equal(threadClass({ agent: "ag_vent", dir, role: "job" }, "Wiki dream vent duty 261103-190500"), "normal");
  assert.equal(threadClass(undefined, "New thread"), undefined);
});

test("PoolLabels puts comm threads in the work tree, sets each tree's class once, and adds and drops lead ids in order", async () => {
  const calls: string[] = [];
  let failClass = true;
  const pool: PoolLabelCalls = {
    treeClass: async (tree: string, priority: PoolClass) => {
      calls.push(`class ${tree} ${priority}`);
      if (failClass) { failClass = false; return "failed"; }
      return "set";
    },
    lead: async (op, session) => { calls.push(`${op} ${session}`); return true; },
  };
  const labels = new PoolLabels(pool);
  labels.agent({ id: "W", name: "vent" }, work);
  await labels.settled();
  assert.deepEqual(calls.splice(0), ["class pi-durable:W high"]);
  labels.agent({ id: "W", name: "vent" }, work);
  labels.agent({ id: "C", name: "vent · DM" }, comm("dm_vent"), "c-root");
  labels.agent({ id: "S", name: "vent · Solo relay" }, comm("so_relay"), "s-root");
  assert.equal(labels.tree("C"), "pi-durable:W");
  assert.equal(labels.tree("S"), "pi-durable:W");
  assert.equal(labels.tree("W"), "pi-durable:W");
  assert.equal(labels.tree("X"), "pi-durable:X");
  labels.agent({ id: "C", name: "vent · DM" }, comm("dm_vent"), "c-root");
  labels.submitted("C");
  labels.submitted("W");
  labels.closed("C");
  labels.closed("C");
  await labels.settled();
  assert.deepEqual(calls.splice(0), ["class pi-durable:W high", "add c-root", "add s-root", "add c-root", "drop c-root"],
    "a failed class is asked again at the next open and then never, a repeated open adds nothing, a root input adds again, and a close drops once");
  labels.agent({ id: "C", name: "vent · DM" }, undefined);
  assert.equal(labels.tree("C"), "pi-durable:C", "a thread whose ref is gone is its own tree again");
});

test("a comm thread runs in its work thread's pool tree, the work tree is high, and its lead id lives beside the chat service's", async () => {
  const poolDir = join(scratch, "pool");
  mkdirSync(poolDir, { recursive: true });
  process.env.PI_POOL_DIR = poolDir;
  const env = { ...process.env, PI_POOL_DIR: poolDir };
  const poolRun = (...args: string[]) => execFileSync("/usr/bin/python3", ["-B", POOL_CLI, ...args], { env, encoding: "utf8" });
  const queue = () => JSON.parse(poolRun("queue", "--json")) as { lead: string[] };
  poolRun("set", "agent_queue_on", "1");
  poolRun("set", "working_max", "4");
  const bin = join(scratch, "pool-hook");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--cli" ]; then shift; exec /usr/bin/python3 -B '${POOL_CLI}' "$@"; fi\nprintf 'sk-ant-oat01-faux'\n`);
  chmodSync(bin, 0o755);

  const turns = new TurnQueue({ bin });
  const labels = new PoolLabels(turns, line => process.stderr.write(`${line}\n`));
  const threads = new DurableThreads({
    dir: join(scratch, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, idleCloseMs: 0, primeRoots: null,
    models: id => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 8 }, () => fauxRespond));
      models.setProvider(poolProvider({ treeKey: () => labels.tree(id), bin, inner: faux.provider, turns }));
      return models;
    },
    settings: id => durableSettings(() => labels.tree(id)),
    inputSettled: (id, session, runContinues) => turns.release({ root: labels.tree(id), session }, runContinues),
    turns: {
      ownerTurn: (id, session) => turns.ownerTurn({ root: labels.tree(id), session }),
      ticket: (id, session) => turns.ticket({ root: labels.tree(id), session }),
    },
    pool: labels,
  });
  try {
    const workThread = await threads.create({ name: "vent" });
    const commThread = await threads.create({ name: "vent · DM" });
    await threads.docPut(commThread.id, "agent.ref", { agent: "ag_vent", dir, role: "comm", room: "dm_vent", work: workThread.id });
    await threads.docPut(workThread.id, "agent.ref", { agent: "ag_vent", dir, role: "work", comm: commThread.id });
    await labels.settled();
    const state = () => JSON.parse(readFileSync(join(poolDir, "state.json"), "utf8")) as { sessions: Record<string, { priority?: string }> };
    assert.equal(state().sessions[`pi-durable:${workThread.id}`]?.priority, "high");
    assert.equal(state().sessions[`pi-durable:${commThread.id}`], undefined, "the comm thread has no tree of its own");

    const sent = await threads.submit(commThread.id, { text: PLAIN_INPUT });
    assert.equal(sent.ticket?.tree, `pi-durable:${workThread.id}`);
    const commSession = sent.ticket!.session;
    assert.deepEqual(queue().lead, [commSession]);
    const settled = await threads.wait(commThread.id, sent.submission);
    assert.equal(settled.status, "done");
    const admitted = readFileSync(join(poolDir, "pi-pool.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event?: string; session?: string; tree?: string })
      .filter(line => line.event === "turn_admitted" && line.session === commSession);
    assert.deepEqual(admitted.map(line => line.tree), [`pi-durable:${workThread.id}`]);

    // The chat service writes its chat heads by replacing the list, and keeps every id it did not write.
    const heads = ["01a1164b-4a2d-742d-b27a-82f086ed0200", "01a11af8-962e-773d-a19a-ee4104011987"];
    const writer = leadWriter({ hostOf: () => null, remotes: () => [], log: () => {},
      local: async ids => { poolRun("lead", ...ids); },
      current: async () => queue().lead,
      store: { read: async () => ({ "": [] }), write: async () => {} } });
    await writer(heads, true);
    assert.deepEqual(queue().lead, [...heads, commSession].sort(), "the chat service's write keeps the comm thread's id");
    await threads.closeThread(commThread.id, "test");
    await labels.settled();
    assert.deepEqual(queue().lead, [...heads].sort(), "closing the comm thread drops only its own id");
    await writer([heads[0]!], true);
    assert.deepEqual(queue().lead, [heads[0]], "the chat service's next write still owns its own ids");
  } finally {
    await threads.shutdown();
    delete process.env.PI_POOL_DIR;
  }
});
