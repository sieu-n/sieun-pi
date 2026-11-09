// Replays 11-09 09:09Z to 10:07Z on us-metal02. The d4 job "wiki dream AI harness developer environment 17:52" (01a1bf83) got 5 more flagged
// pages at 09:09:36Z and wrote them with 11 subagents. They parked on their provider quota at 09:16:12Z to 09:16:24Z and again at 09:32:17Z,
// and the idle unload stopped the root at 09:18:19Z. At 10:06:15Z the unload stopped the 11 as pool waits for their 10:09Z to 10:10Z slots,
// which left them no quota-resume job, so the runner read the root as ended and archived it at 10:07:06Z. The job sweep then skipped the
// archived tree, and no subagent came back to finish its page or report.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type JobTree, treeWait } from "../src/duty-tree-wait.ts";
import { dailySlot } from "../src/shared/chat-duties.ts";
import type { SessionRow, ThreadSchedule } from "../src/shared/types.ts";
import type { Wake } from "../src/wakes.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB = { id: "01a1bf83-83d8-72fe-8faa-653bb4544013", name: "wiki dream AI harness developer environment 17:52" };
const SUBAGENTS = [
  ["01a1bf97-160d-738a-9da7-69dd4f47e208", "wd2-projects-sirocco-goal-checks"], ["01a1bf97-1f15-7757-8c15-8c2b08b53efb", "wd2-apps-crawler-v3-platforms-meta-ads-running"],
  ["01a1bf97-2796-7272-9124-3b4e29c68ebf", "wd2-mains-devops-stability-pipeline-alerts-and-agents"], ["01a1bf97-3121-7009-a5a4-060ab2bffe4b", "wd2-architecture-instagram-authed-engage-tagged-lane"],
  ["01a1bf97-393a-772b-919c-8b60f3a5e85f", "wd2-projects-b2-media-packs-index"], ["01a1bf97-41d9-71cf-993d-198122c82038", "wd2-cture-docker-and-containers-deploy-and-supervisor"],
  ["01a1bf97-4aa6-74b7-9210-17459018be48", "wd2-apps-search-chat-operator"], ["01a1bf97-5583-752e-84b5-0fa943bff9e4", "wd2-apps-llm-wiki-index"],
  ["01a1bf97-610f-7100-9501-7702928afac3", "wd2-apps-llm-wiki-philosophy-index"], ["01a1bf97-6c33-711c-b735-255a086ffeae", "wd2-apps-llm-wiki-prior-art"],
  ["01a1bf97-7703-7546-a5f5-f476c0e06de8", "wd2-apps-crawler-v3-fleet-findings"],
] as const;
const FIRST = SUBAGENTS[0][1];
const at = (clock: string): number => Date.parse(`2026-11-09T${clock}Z`);

/** A daemon row; `loaded` false is a session the idle unload stopped, which keeps no active session id. */
const summary = (sessionId: string, name: string, parent: string | undefined, loaded: boolean, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sessionId, sessionId, sessionName: name, cwd: "/home/sieun", lifecycle: "live", activity: "idle", isSessionActive: false, isStreaming: false,
  isCompacting: false, attachedClients: 0, messageCount: 40, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, workerState: "ready",
  ...loaded ? { activeSessionId: `active-${sessionId}` } : {}, ...parent ? { parentSessionId: parent, runtimeKind: "subagent" as const } : {}, ...fields }) as SessionSummary;

const quotaResume = (until: string): ThreadSchedule => ({ kind: "cron", status: "active", expression: `at ${until}`, label: "quota-resume", nextRunAt: until });

/** The 17:52 tree as the daemon, the scheduled jobs, the job sweep's pool holds and the outbox list it at one moment. */
interface Moment { root: SessionSummary; subagents: SessionSummary[]; scheduled: Map<string, ThreadSchedule>; held: Set<string>; relays: { id: string; threadId: string }[] }

function replay(dir: string) {
  let now = at("09:09:36");
  let moment: Moment = { root: summary(JOB.id, JOB.name, undefined, true), subagents: [], scheduled: new Map(), held: new Set(), relays: [] };
  const tree: JobTree = {
    sessions: id => id === JOB.id ? [moment.root, ...moment.subagents] : [],
    queue: async () => ({ queued: [], busy: false }),
    relay: async sessions => moment.relays.find(entry => sessions.has(entry.threadId)),
    wakes: async (): Promise<Wake[]> => [],
    held: () => moment.held,
  };
  const row = (): SessionRow => ({ id: JOB.id, name: JOB.name, cwd: "/home/sieun", kind: "live", status: "idle", archived: false, messageCount: 214,
    working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user" }) as SessionRow;
  const archived: string[] = [];
  const lines: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async job => { archived.push(job.id); } }, registry: {} as never, board: id => id,
    log: line => lines.push(line), rows: async () => [row()], schedules: async () => moment.scheduled, held: () => moment.held,
    treeWait: (id, scheduled) => treeWait(id, tree, scheduled) });
  return { host, tree, archived, lines, now: () => now, set: (clock: string, next: Partial<Moment>) => { now = at(clock); moment = { ...moment, ...next }; } };
}

const all = (loaded: boolean, fields: Partial<SessionSummary> = {}): SessionSummary[] => SUBAGENTS.map(([id, name]) => summary(id, name, JOB.id, loaded, fields));
const ids = new Set(SUBAGENTS.map(([id]) => id));

test("a duty job whose subagents wait on pi-pool for their slots stays up and at work, from 09:09Z to 10:07Z on 11-09", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-tree-pool-held-"));
  const r = replay(dir);
  const ended = async () => (await r.host.ended!([JOB])).map(job => job.id);
  const working = () => r.host.working(JOB);
  try {
    r.set("09:09:36", { subagents: all(true, { activity: "working", isSessionActive: true }) });
    assert.deepEqual(await ended(), [], "09:09Z: the root's turn ended while its 11 subagents write");
    assert.equal(await working(), true);

    r.set("09:16:46", { subagents: all(false), scheduled: new Map(SUBAGENTS.map(([id]) => [id, quotaResume("2026-11-09T09:32:00.000Z")])) });
    assert.deepEqual(await ended(), [], "09:16Z: each subagent parked on its quota holds a quota-resume job");
    assert.match(r.lines.join("\n"), new RegExp(`not stopped, its subagent ${FIRST} has an active scheduled job \\(quota-resume\\)`));

    r.set("09:24:41", { root: summary(JOB.id, JOB.name, undefined, false), held: new Set(ids) });
    assert.deepEqual(await ended(), [], "09:18Z: the idle unload stopped the root, which leaves it listed");
    assert.equal(await working(), true, "09:24Z: d4's push run reads the job as still at work");

    r.set("09:32:17", { scheduled: new Map(SUBAGENTS.map(([id]) => [id, quotaResume("2026-11-09T10:04:30.000Z")])) });
    assert.deepEqual(await ended(), [], "09:32Z: the quota-resume met the same limit and parked each subagent again");

    r.set("10:07:06", { scheduled: new Map() });
    assert.deepEqual(await ended(), [], "10:07:06Z: the runner archived the root while pi-pool held its 11 subagents for 10:09Z to 10:10Z");
    assert.equal(await working(), true, "10:06:48Z: d4's verify run read the job as ended");
    assert.match(r.lines.join("\n"), new RegExp(`not stopped, its subagent ${FIRST} waits on pi-pool for its slot`));

    r.set("10:12:00", { held: new Set(), subagents: [...all(false).slice(1), summary(SUBAGENTS[0][0], FIRST, JOB.id, true)],
      relays: [{ id: "report-sirocco", threadId: JOB.id }] });
    assert.deepEqual(await ended(), [], "a subagent's report on its way to the stopped root wakes it, and the root stays up until it arrives");
    assert.match(r.lines.join("\n"), /not stopped, agent message report-sirocco waits in the outbox for its root/);

    r.set("10:20:00", { relays: [] });
    assert.deepEqual(await ended(), [JOB.id], "once nothing in its tree waits, the root ends");
    assert.equal(await working(), false);
    assert.deepEqual(r.archived, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the duty runner archives the 17:52 job only after pi-pool lets go of its subagents (11-09 10:07:06Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-tree-pool-runner-"));
  const r = replay(dir);
  const measures = join(dir, "measures");
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { appendFileSync, writeFileSync } from "node:fs"; appendFileSync(${JSON.stringify(measures)}, "x"); writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 0 } }));`);
  const store = new DutyStore(dir);
  const started = at("08:53:52");
  const lastSlotAt = dailySlot("17:52", at("10:07:06"));
  await store.update(CHAT, duties => {
    duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays true", goal: "no flagged wiki page",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }],
      schedule: { kind: "daily", at: "17:52" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the pages",
      status: "active", createdAt: started - 48 * 3_600_000, updatedAt: started - 48 * 3_600_000, runCount: 2, lastSlotAt, lastRunAt: lastSlotAt });
  });
  await store.appendRun(CHAT, { duty: "d4", at: started, slot: started, trigger: "schedule", ms: 900, verdict: "missed",
    metrics: { wiki_problems: { value: 1, target: 0, op: "<=", met: false } }, summary: "wiki_problems 1", job: JOB });
  const duties = new Duties(store, { isChat: async () => true, now: r.now, tickMs: 0, node: process.execPath, log: line => r.lines.push(line),
    jobs: { ...r.host, chat: async id => ({ id, name: "AI harness developer environment", cwd: dir, board: id }), start: async (_chat, name) => ({ id: `job-${name}`, name }) } });
  const tick = async () => { await duties.tick(); await duties.settled(); };
  try {
    r.set("10:07:06", { root: summary(JOB.id, JOB.name, undefined, false), subagents: all(false), held: new Set(ids) });
    await tick();
    assert.deepEqual(r.archived, [], "10:07:06Z: pi-pool holds the 11 subagents, so the root is kept");
    assert.equal(await readFile(measures, "utf8").catch(() => ""), "", "a job still at work gets no after-job measure");

    r.set("10:20:00", { held: new Set() });
    await tick();
    assert.deepEqual(r.archived, [JOB.id], "once no subagent waits, the runner measures the run and archives the job");
  } finally { duties.close(); await rm(dir, { recursive: true, force: true }); }
});
