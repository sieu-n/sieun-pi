/**
 * The `rlm_heartbeat` skill in durable threads (`heartbeat.ts`), through real kernel cells and pi-host's `Scheduler` on a test clock:
 * 1. create, list, update and delete answer as Prime's `handleRlmHeartbeatHostRequest` does, for the conversation's own session only.
 * 2. A due heartbeat arrives in the conversation as an `agent.message` input from "heartbeat" with Prime's `[heartbeat: ...]` text.
 * 3. After the thread closes, a due heartbeat reopens it through the thread list (`reopenDurableHeartbeat`), and an archived thread's
 *    heartbeats are cancelled at that reopen instead of delivered.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { durableTarget, heartbeatModule, reopenDurableHeartbeat, type HeartbeatThreads } from "../../src/durable/heartbeat.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { cell, context, entriesOf, inputs, lastText, openThread, results, rlmOptions, say, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-heartbeat-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "threads"));
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const fileOf = (id: string) => join(dir, "threads", `${id}.sqlite`);
let clock = Date.parse("2026-11-03T00:00:00Z");
/** What the scheduler's reopen reaches; each test sets it before a tick that finds no handle. */
let threads: HeartbeatThreads = { fileOf, info: () => ({ archived: false }), submit: () => Promise.reject(new Error("no thread list in this test")) };
const lines: string[] = [];
const scheduler = new Scheduler({
  dataDir: join(dir, "pi-host"),
  reopen: async job => { if (!reopenDurableHeartbeat(scheduler, job, threads, line => lines.push(line))) throw new Error(`${job.activeSessionId} is not a durable job`); },
  log: line => lines.push(line),
  now: () => new Date(clock),
});

let rlm: DurableRlm;
before(async () => {
  await testPython();
  const options = rlmOptions(dir);
  // The Python skill the prompt lists, as pi-host ships it in `pi-host/skills`.
  symlinkSync(join(import.meta.dirname, "../../skills/rlm-heartbeat"), join(options.bundledSkillsDir, "rlm-heartbeat"));
  rlm = await DurableRlm.load({ ...options, modules: [heartbeatModule({ agentDir: options.agentDir, log: line => lines.push(line), scheduler: () => scheduler })] });
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

/** Moves the test clock past the next tick and delivers what came due. */
async function tick(ms: number): Promise<number> {
  clock += ms;
  const claimed = await scheduler.runDue();
  await scheduler.idle();
  return claimed;
}

const beats = (harness: Harness) => entriesOf(harness).then(entries => inputs(entries).filter(i => i.data?.from === "heartbeat"));

test("create, list, update and delete answer as Prime does, from a real kernel cell", async () => {
  const code = [
    "import json, rlm_heartbeat as hb",
    "c = await hb.create('check the build', interval='10s', label='build')",
    "i = c['heartbeat']['id']",
    "out = {'create': c, 'list': await hb.list()}",
    "out['pause'] = await hb.update(i, status='pause')",
    "out['resume'] = await hb.update(i, status='resume', label='ci', delivery_mode='follow_up')",
    "out['other'] = await hb.update('no-such-id', label='x')",
    "out['delete'] = await hb.delete(i)",
    "out['after'] = await hb.list()",
    "out['all'] = await hb.list(include_inactive=True)",
    "try:\n    await hb.update(i)\nexcept Exception as e:\n    out['empty'] = str(e)",
    "print(json.dumps(out))",
  ].join("\n");
  const { harness, root } = await openThread(fileOf("hb-crud"), "hb-crud", rlm, ({ messages }) => (lastText(messages) === "go" ? cell(code) : say("done")), dir);
  await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await rlm.closeThread("hb-crud", "idle");
  assert.equal(out[0]!.isError, false, out[0]!.text);
  const r = JSON.parse(out[0]!.text) as Record<string, { heartbeat?: Record<string, unknown>; heartbeats?: Record<string, unknown>[] }> & { empty?: string };
  const created = r.create!.heartbeat!;
  assert.deepEqual(
    { status: created.status, label: created.label, delivery_mode: created.delivery_mode, instruction: created.instruction, schedule: created.schedule, run_count: created.run_count, next_run_at: created.next_run_at },
    { status: "active", label: "build", delivery_mode: "steer", instruction: "check the build", schedule: { kind: "interval", expression: "every 10s", intervalMs: 10_000 }, run_count: 0, next_run_at: new Date(clock + 10_000).toISOString() },
  );
  assert.deepEqual(r.list!.heartbeats!.map(h => h.id), [created.id]);
  assert.equal(r.pause!.heartbeat!.status, "paused");
  assert.equal(r.pause!.heartbeat!.next_run_at, null);
  assert.deepEqual([r.resume!.heartbeat!.status, r.resume!.heartbeat!.label, r.resume!.heartbeat!.delivery_mode], ["active", "ci", "follow_up"]);
  assert.equal(r.other!.heartbeat, null);
  assert.equal(r.delete!.heartbeat!.status, "cancelled");
  assert.deepEqual(r.after!.heartbeats, []);
  assert.deepEqual(r.all!.heartbeats!.map(h => [h.id, h.status]), [[created.id, "cancelled"]]);
  assert.match(r.empty ?? "", /requires at least one field/);
  const job = scheduler.list({ includeInactive: true }).find(j => j.id === created.id)!;
  assert.deepEqual([job.activeSessionId, job.sessionFile, job.runtimeKind, job.source], ["hb-crud", fileOf("hb-crud"), "top-level", "rlm_heartbeat"]);
});

test("a due heartbeat arrives in the conversation as an input from heartbeat, with Prime's text", async () => {
  const respond: FauxResponseFactory = ({ messages }) => {
    const last = lastText(messages);
    if (last === "beat") return cell("import rlm_heartbeat as hb\nprint((await hb.create('look at the queue', interval='10s', label='queue'))['heartbeat']['id'])");
    if (last.startsWith("[heartbeat:")) return say("queue looked at");
    return say("armed");
  };
  const { harness, root } = await openThread(fileOf("hb-due"), "hb-due", rlm, respond, dir);
  await (await root.submit({ type: "input", content: "beat" }, context)).wait(context);
  const id = results(await entriesOf(harness))[0]!.text.trim();
  assert.equal(await tick(9_000), 0);
  assert.equal(await tick(1_000), 1);
  const [beat] = await until("the heartbeat input", async () => (await beats(harness)).at(0) && beats(harness));
  assert.equal(beat!.kind, "agent.message");
  assert.deepEqual(beat!.data, { from: "heartbeat", via: "rlm_heartbeat" });
  assert.equal(beat!.text, "[heartbeat: every 10s run#1]\n\nlook at the queue");
  await until("the heartbeat's answer", async () => inputs(await entriesOf(harness)).length >= 2 && (await entriesOf(harness)).some(e => JSON.stringify(e.model ?? "").includes("queue looked at")));
  const job = scheduler.list({ sessionId: "hb-due" }).find(j => j.id === id)!;
  assert.deepEqual([job.runCount, job.lastError, job.claimedAt], [1, undefined, undefined]);
  await harness.close(context);
  await rlm.closeThread("hb-due", "idle");
  scheduler.deleteRlmHeartbeat("hb-due", id);
});

test("after the thread closes a due heartbeat reopens it through the thread list, and an archived thread's heartbeats are cancelled", async () => {
  const respond: FauxResponseFactory = ({ messages }) => {
    const last = lastText(messages);
    if (last === "beat") return cell("import rlm_heartbeat as hb\nprint((await hb.create('read the board', interval='10s'))['heartbeat']['id'])");
    if (last.startsWith("[heartbeat:")) return say("board read");
    return say("armed");
  };
  const first = await openThread(fileOf("hb-closed"), "hb-closed", rlm, respond, dir);
  await (await first.root.submit({ type: "input", content: "beat" }, context)).wait(context);
  const id = results(await entriesOf(first.harness))[0]!.text.trim();
  await first.harness.close(context);
  await rlm.closeThread("hb-closed", "idle");
  assert.equal(scheduler.handle("hb-closed"), undefined);

  let reopened: Awaited<ReturnType<typeof openThread>> | undefined;
  let archived = false;
  threads = {
    fileOf, info: () => ({ archived }),
    submit: async (thread, input) => {
      reopened ??= await openThread(fileOf(thread), thread, rlm, respond, dir);
      const conversation = await reopened.harness.conversation(input.conversation as never, context);
      return conversation!.submit({ type: "input", content: input.text, requestId: input.requestId, whenBusy: input.whenBusy, entry: input.entry }, context);
    },
  };
  assert.equal(await tick(10_000), 1);
  const harness = await until("the reopened thread", async () => reopened?.harness);
  const [beat] = await until("the heartbeat input", async () => (await beats(harness)).at(0) && beats(harness));
  assert.equal(beat!.text, "[heartbeat: every 10s run#1]\n\nread the board");
  await until("the heartbeat's answer", async () => (await entriesOf(harness)).some(e => JSON.stringify(e.model ?? "").includes("board read")));
  await harness.close(context);
  await rlm.closeThread("hb-closed", "idle");

  archived = true;
  reopened = undefined;
  assert.equal(await tick(10_000), 1);
  const job = scheduler.list({ includeInactive: true }).find(j => j.id === id)!;
  assert.equal(job.status, "cancelled");
  assert.match(job.lastError ?? "", /archived; its heartbeats were cancelled/);
  assert.equal(reopened, undefined);
});

test("a durable job names its thread and conversation by the thread file, and a pi session's job names none", () => {
  const job = (activeSessionId: string, sessionFile: string) => ({ activeSessionId, sessionFile });
  assert.deepEqual(durableTarget(job("a1-b2", fileOf("a1-b2")), { fileOf }), { thread: "a1-b2", conversation: 1 });
  assert.deepEqual(durableTarget(job("a1-b2-3", fileOf("a1-b2")), { fileOf }), { thread: "a1-b2", conversation: 3 });
  assert.equal(durableTarget(job("a1-b2-x", fileOf("a1-b2")), { fileOf }), undefined);
  assert.equal(durableTarget(job("a1-b2", join(dir, "sessions", "a1-b2.jsonl")), { fileOf }), undefined);
  assert.equal(durableTarget(job("a1-b2", join(dir, "elsewhere", "a1-b2.sqlite")), { fileOf }), undefined);
});
