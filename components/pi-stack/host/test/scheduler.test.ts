import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Server } from "node:net";
import { kernelHandler } from "../../shared/kernel-bridge.ts";
import { HostClient } from "../src/client.ts";
import { PiHost, type HostOptions } from "../src/host.ts";
import type { SessionSummary } from "../src/protocol.ts";
import { defers, parseHeartbeatCommand, parseSchedule, type Job } from "../src/schedule.ts";
import { JOBS_FILE } from "../src/scheduler.ts";
import { listen } from "../src/server.ts";
import echo from "./fixtures/echo.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

let root: string;
let clock = Date.parse("2026-10-27T08:00:00Z");
const now = () => new Date(clock);
let host: PiHost;
let server: Server;
let client: HostClient;

const options = (extra: Partial<HostOptions> = {}): HostOptions => ({
  agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), dataDir: join(root, "host-data"), defaultCwd: join(root, "ws"),
  extensionFactories: [echo], defaultModel: { provider: "echo", id: "m" }, now, log: () => {},
  resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, ...extra,
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-host-sched-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  host = new PiHost(options());
  server = await listen(host, join(root, "host.sock"));
  client = await HostClient.connect(join(root, "host.sock"));
});

after(async () => {
  client.close();
  await host.shutdown();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

/** Custom and user texts in the session file, which is what lands in the transcript whether or not the session is loaded. */
function transcript(file: string): { type: string; text: string }[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).flatMap(entry => {
    if (entry.type === "custom_message") return [{ type: entry.customType as string, text: String(entry.content) }];
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content.map((part: { text?: string }) => part.text ?? "").join("");
      return [{ type: entry.message.role as string, text }];
    }
    return [];
  });
}

async function until(test: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !test(); await new Promise(resolve => setTimeout(resolve, 25))) if (Date.now() > end) throw new Error("timed out");
}

async function fire(target: PiHost = host): Promise<number> {
  const claimed = await target.scheduler.runDue();
  await target.scheduler.idle();
  return claimed;
}

async function session(name: string, target: PiHost = host) {
  const opened = await target.openSession({ name });
  await target.startPrompt(opened, `hello from ${name}`);
  await opened.session.waitForIdle();
  return { id: opened.id, file: opened.session.sessionFile! };
}

test("the schedule grammar and the /heartbeat arguments match Prime's", () => {
  const at = new Date("2026-10-27T08:00:00Z");
  assert.equal(parseSchedule("every 30s", at).schedule.intervalMs, 30_000);
  assert.equal(parseSchedule("in 5m", at).nextRunAt.toISOString(), "2026-10-27T08:05:00.000Z");
  assert.equal(parseSchedule("@hourly", at).schedule.expression, "0 * * * *");
  assert.equal(parseSchedule("*/15 * * * *", at).nextRunAt.getUTCMinutes() % 15, 0);
  assert.throws(() => parseSchedule("every 5s", at), /at least 10 seconds/);
  assert.deepEqual(parseHeartbeatCommand("/heartbeat every 10m --follow-up check the deploy"), { type: "set", schedule: "every 10m", instruction: "check the deploy", deliveryMode: "follow_up" });
  assert.deepEqual(parseHeartbeatCommand("--every 2h watch CI"), { type: "set", schedule: "every 2h", instruction: "watch CI" });
  assert.deepEqual(parseHeartbeatCommand("stop"), { type: "clear" });
  const job = { source: "heartbeat", deliveryMode: "follow_up" } as Job;
  assert.equal(defers(job, { streaming: true, compacting: false, retrying: false, pending: false }), true);
  assert.equal(defers({ ...job, deliveryMode: "steer" }, { streaming: true, compacting: false, retrying: false, pending: false }), false);
  assert.equal(defers({ ...job, deliveryMode: "steer" }, { streaming: false, compacting: true, retrying: false, pending: false }), true);
});

test("heartbeat_set over the socket sends heartbeats_changed, and the tick lands as a heartbeat_prompt the agent answers", async () => {
  const { id, file } = await session("beat");
  const seen = client.lines.length;
  const set = await client.call<{ heartbeat: Job }>({ type: "heartbeat_set", activeSessionId: id, schedule: "every 10m", prompt: "check the deploy" });
  assert.equal(set.heartbeat.source, "heartbeat");
  assert.equal(set.heartbeat.deliveryMode, "steer");
  await client.waitFor(line => line.type === "heartbeats_changed" && client.lines.indexOf(line) >= seen);
  const got = await client.call<{ heartbeat: Job }>({ type: "heartbeat_get", activeSessionId: id });
  assert.equal(got.heartbeat.id, set.heartbeat.id);
  const state = await client.call<{ heartbeat: Job | null }>({ type: "get_connection_state", activeSessionId: id });
  assert.equal(state.heartbeat?.id, set.heartbeat.id);
  const listed = await client.call<{ jobs: Job[] }>({ type: "cron_list" });
  assert.ok(listed.jobs.some(job => job.id === set.heartbeat.id && job.sessionId === id));
  clock += 10 * 60_000 + 1;
  assert.equal(await fire(), 1);
  await host.sessions.get(id)!.session.waitForIdle();
  const lines = transcript(file);
  const beat = lines.findIndex(line => line.type === "heartbeat_prompt");
  assert.match(lines[beat]!.text, /^\[heartbeat: every 10m run#1\]\n\ncheck the deploy$/);
  assert.equal(lines[beat + 1]?.type, "assistant", "the heartbeat started a turn");
  const after = (await client.call<{ heartbeat: Job }>({ type: "heartbeat_get", activeSessionId: id })).heartbeat;
  assert.equal(after.runCount, 1);
  assert.equal(after.nextRunAt, new Date(clock + 10 * 60_000).toISOString());
  await client.call({ type: "heartbeat_update", activeSessionId: id, action: "clear" });
  assert.equal((await client.call<{ heartbeat: Job | null }>({ type: "heartbeat_get", activeSessionId: id })).heartbeat, null);
});

test("a heartbeat due for an unloaded session reopens it and its prompt lands in the transcript", async () => {
  const { id, file } = await session("sleeper");
  await client.call({ type: "heartbeat_set", activeSessionId: id, schedule: "every 1m", prompt: "wake and report" });
  await host.kill(id, "idle_unload");
  assert.equal(host.sessions.has(id), false);
  clock += 60_000 + 1;
  assert.equal(await fire(), 1);
  assert.equal(host.sessions.has(id), true, "the scheduler reopened the session");
  await host.sessions.get(id)!.session.waitForIdle();
  const lines = transcript(file);
  assert.deepEqual(lines.map(line => line.type), ["user", "assistant", "heartbeat_prompt", "assistant"]);
  assert.match(lines[2]!.text, /wake and report/);
});

test("rlm_heartbeat host requests create, list, pause and delete through the kernel bridge", async () => {
  const { id, file } = await session("rlm-owner");
  const call = (method: string, payload: Record<string, unknown>) => kernelHandler(id, method)!(payload) as Record<string, any>;
  const created = call("rlm_heartbeat.create", { instruction: "check the tests", interval: "2m", label: "tests", delivery_mode: "follow_up" });
  assert.equal(created.heartbeat.label, "tests");
  assert.equal(created.heartbeat.delivery_mode, "follow_up");
  assert.equal(created.heartbeat.schedule.expression, "every 2m");
  const second = call("rlm_heartbeat.create", { instruction: "watch deploy" });
  assert.equal(second.heartbeat.schedule.expression, "every 5m");
  assert.equal(call("rlm_heartbeat.list", {}).heartbeats.length, 2);
  const paused = call("rlm_heartbeat.update", { id: created.heartbeat.id, status: "pause" });
  assert.equal(paused.heartbeat.status, "paused");
  assert.equal(paused.heartbeat.next_run_at, null);
  assert.equal(call("rlm_heartbeat.delete", { id: second.heartbeat.id }).heartbeat.status, "cancelled");
  assert.equal(call("rlm_heartbeat.list", {}).heartbeats.length, 1);
  assert.equal(call("rlm_heartbeat.list", { include_inactive: true }).heartbeats.length, 2);
  assert.throws(() => call("rlm_heartbeat.update", { id: created.heartbeat.id }), /at least one field/);
  call("rlm_heartbeat.update", { id: created.heartbeat.id, status: "resume", delivery_mode: "steer" });
  clock += 2 * 60_000 + 1;
  await fire();
  await host.sessions.get(id)!.session.waitForIdle();
  assert.ok(transcript(file).some(line => line.type === "heartbeat_prompt" && line.text.includes("check the tests")));
});

test("kill cancels the session's jobs, and cron_add runs a one-shot prompt once", async () => {
  const doomed = await session("doomed");
  await client.call({ type: "heartbeat_set", activeSessionId: doomed.id, schedule: "every 5m", prompt: "never" });
  await client.call({ type: "kill", activeSessionId: doomed.id });
  assert.deepEqual((await client.call<{ jobs: Job[] }>({ type: "cron_list", activeSessionId: doomed.id })).jobs, []);
  const { id, file } = await session("cron");
  const added = await client.call<{ job: Job }>({ type: "cron_add", activeSessionId: id, schedule: "in 1m", prompt: "one-shot prompt" });
  clock += 60_000 + 1;
  await fire();
  await host.sessions.get(id)!.session.waitForIdle();
  assert.equal(transcript(file).filter(line => line.type === "user" && line.text === "one-shot prompt").length, 1);
  const all = await client.call<{ jobs: Job[] }>({ type: "cron_list", includeInactive: true });
  assert.equal(all.jobs.find(job => job.id === added.job.id)?.status, "completed");
  clock += 60 * 60_000;
  await fire();
  await host.sessions.get(id)!.session.waitForIdle();
  assert.equal(transcript(file).filter(line => line.type === "user" && line.text === "one-shot prompt").length, 1, "a completed one-shot never runs again");
});

test("a new host reads the jobs file, does not replay a claimed tick, and fires a due job into a session it never opened", async () => {
  const { id, file } = await session("restart");
  await client.call({ type: "heartbeat_set", activeSessionId: id, schedule: "every 1m", prompt: "after restart" });
  const second = new PiHost(options({ dataDir: join(root, "host-data-2"), sessionDir: join(root, "sessions-2") }));
  try {
    const other = await session("claimed", second);
    second.scheduler.setHeartbeat(other.id, "every 1m", "claimed tick");
  } finally { await second.shutdown(); }
  const jobsFile = join(root, "host-data-2", JOBS_FILE);
  const saved = JSON.parse(readFileSync(jobsFile, "utf8")) as { jobs: Job[] };
  saved.jobs[0]!.claimedAt = new Date(clock).toISOString();
  saved.jobs[0]!.nextRunAt = new Date(clock + 60_000).toISOString();
  writeFileSync(jobsFile, JSON.stringify(saved));
  const third = new PiHost(options({ dataDir: join(root, "host-data-2"), sessionDir: join(root, "sessions-2") }));
  try {
    const recovered = third.scheduler.list()[0]!;
    assert.equal(recovered.claimedAt, undefined);
    assert.match(recovered.lastError ?? "", /^interrupted/);
    assert.equal(recovered.runCount, 0);
  } finally { await third.shutdown(); }

  await host.shutdown();
  server.close();
  client.close();
  host = new PiHost(options());
  server = await listen(host, join(root, "host.sock"));
  client = await HostClient.connect(join(root, "host.sock"));
  assert.equal(host.sessions.size, 0);
  clock += 60_000 + 1;
  await fire();
  assert.equal(host.sessions.has(id), true);
  await host.sessions.get(id)!.session.waitForIdle();
  await until(() => transcript(file).at(-1)?.type === "assistant" && transcript(file).some(line => line.text.includes("after restart")));
});
