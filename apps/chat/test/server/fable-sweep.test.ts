/**
 * `scripts/duties/fable-sweep.ts`, the fable auditor's 3-hourly sweep:
 * 1. An owner post counts as answered once an agent posts after it in its scope, a later answered post of his covers it, or a reaction
 *    other than 👀 says it all; a post that reached no agent in a channel is a delivery error.
 * 2. A step is stalled only when no live job, running wait, board.wake the app owes, open todo or recent job entry moves it.
 * 3. A working job with no entry for 45 min is stuck, and a job that failed in the last 24 h is listed.
 * 4. An item is worth a look when it is new or was last raised 24 h ago, so a quiet run starts no job.
 * 5. A sweep's findings count as passed on once the agent posts in its DM after the run or its job answered "nothing to report"; a sweep
 *    that finds things is the duty working, so after mode reads 0 then (c67).
 * 6. Each item carries what a reviewer needs to judge it, so the Fable turn reads one file: a duty's last three runs and fix step, and three or
 *    more jobs that wait for a model account as one item.
 * 7. A duty miss its owner has already, a fix step with a working or sleeping job or a board.wake, or the duty's first run, is passed on and
 *    never fresh, and a verify run (a closed fix step) confirms the last sweep's items and starts no new sweep (11-24, 15:32 KST).
 * 8. A Fable work thread is an item unless it is the advisor's own or the owner set that model himself from his page (11-28, 19:19 KST).
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { measure } from "../../server/duty-run.ts";
import {
  answerOf, dutyContext, jobFindings, lastEntries, noModelTurn, notMeasured, parkedJobs, passedOn, unmovedMetrics, postFindings, reportState, stalledSteps, sweepMode, worthALook, type DutyRunView, type Item, type Job,
  type PlanItem, type Post,
} from "../../scripts/duties/fable-sweep.ts";
import { judge, type Duty, type DutyMetric, type DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";

const MIN = 60_000;
const now = Date.parse("2026-11-22T12:00:00Z");
const owner = { id: "owner", kind: "owner" };
const agent = { id: "ag_x", kind: "chat", name: "x" };
const delivered = [{ target: "ag_x", name: "x", state: "delivered", at: 0 }];
const post = (id: string, minutesAgo: number, extra: Partial<Post> = {}): Post => ({ id, at: now - minutesAgo * MIN, author: owner, text: id, deliveries: delivered, ...extra });
const reply = (id: string, minutesAgo: number, extra: Partial<Post> = {}): Post => ({ id, at: now - minutesAgo * MIN, author: agent, text: id, ...extra });
const dm = (scope: Post[]) => postFindings({ room: "dm_x", roomName: "DM x", kind: "dm", scope, link: p => `#/c/dm_x?m=${p.id}`, now });

test("a DM post with no agent post after it is unanswered once 10 min pass", () => {
  assert.deepEqual(dm([post("p1", 30), reply("p2", 25, { answers: "p1" }), post("p3", 20)]).map(i => [i.kind, i.sig]), [["owner_unanswered", "post:dm_x/p3"]]);
  assert.deepEqual(dm([post("p1", 5)]), []);
  assert.deepEqual(dm([post("p1", 200)]), [], "older than the 3 h window");
});

test("a follow-up merged into a later answer counts as answered", () => {
  assert.deepEqual(dm([post("p1", 40), post("p2", 39), reply("p3", 30, { answers: "p1" })]), []);
});

test("only a reaction other than 👀 answers a post", () => {
  assert.equal(dm([post("p1", 30, { reactions: [{ emoji: "👀", by: [agent] }] })]).length, 1);
  assert.equal(dm([post("p1", 30, { reactions: [{ emoji: "✅", by: [agent] }] })]).length, 0);
  assert.equal(dm([post("p1", 30, { reactions: [{ emoji: "✅", by: [owner] }] })]).length, 1);
});

test("a delivery read as answered or a done flag answers a post", () => {
  assert.equal(dm([post("p1", 30, { deliveries: [{ target: "ag_x", name: "x", state: "answered", at: 0 }] })]).length, 0);
  assert.equal(dm([post("p1", 30, { done: { at: now } })]).length, 0);
});

test("a channel root post is answered in its own thread, and one that reached no agent is a delivery error", () => {
  const threads: Record<string, Post[]> = { p1: [reply("r1", 20)] };
  const run = (scope: Post[]) => postFindings({ room: "ch_1", roomName: "#c", kind: "channel", scope, ownThread: root => threads[root] ?? [], link: p => p.id, now });
  assert.deepEqual(run([post("p1", 30)]), []);
  assert.deepEqual(run([post("p2", 30, { deliveries: [] })]).map(i => i.kind), ["delivery_error"]);
  assert.deepEqual(run([post("p3", 30, { deliveries: [{ target: "ag_x", name: "x", state: "failed", at: 0 }] })]).map(i => i.kind), ["delivery_error", "owner_unanswered"]);
  assert.deepEqual(run([post("p4", 12, { deliveries: [{ target: "ag_x", name: "x", state: "queued", at: 0 }] })]).map(i => i.kind), ["delivery_error", "owner_unanswered"]);
});

test("a thread reply is owed by the agents its root names or that replied, and an edit of their earlier reply after it answers it (#komodo p3, p4, 11-24)", () => {
  const factory = { id: "ag_agent-factory", kind: "chat", name: "agent factory" };
  const misc = [{ target: "ag_search-product-misc", name: "Search product, misc.", state: "delivered", at: 0 }];
  const run = (scope: Post[]) => postFindings({ room: "ch_k", roomName: "#komodo", kind: "channel", scope, link: p => p.id, now,
    involved: [{ id: "ag_agent-factory", name: "agent factory" }] });
  const p2 = (editedMinutesAgo?: number) => reply("p2", 40, { author: factory, answers: "p1", ...editedMinutesAgo === undefined ? {} : { editedAt: now - editedMinutesAgo * MIN } });
  assert.deepEqual(run([p2(5), post("p3", 39, { deliveries: misc }), post("p4", 38, { deliveries: misc })]), [], "p2's edit after p3 and p4 answers both");
  const open = run([p2(), post("p3", 39, { deliveries: misc })]);
  assert.deepEqual(open.map(i => [i.kind, i.agent]), [["owner_unanswered", "agent factory"]], "the thread's agent owes it, not the room member it reached");
  assert.equal(run([p2(45), post("p3", 39, { deliveries: misc })]).length, 1, "an edit before his post answers nothing");
  const other = postFindings({ room: "ch_k", roomName: "#komodo", kind: "channel", scope: [reply("p2", 40, { editedAt: now - 5 * MIN }), post("p3", 39)], link: p => p.id, now,
    involved: [{ id: "ag_agent-factory", name: "agent factory" }] });
  assert.equal(other.length, 1, "an edit by an agent outside the thread answers nothing");
});

const job = (name: string, status: string, extra: Partial<Job> = {}): Job => ({ id: `t:${name}`, name, status, thread: "t", conversation: 2, createdAt: now - 300 * MIN, agent: { id: "ag_x", name: "x" }, ...extra });
const theAgent = { id: "ag_x", name: "x", status: "idle", thread: "t" };

test("a step is stalled only when nothing moves it", () => {
  const plan = [
    { id: "p1", text: "live job", status: "doing", job: "a" },
    { id: "p2", text: "idle job, old entry", status: "doing", job: "b" },
    { id: "p3", text: "idle job, fresh entry", status: "doing", job: "c" },
    { id: "p4", text: "held by a todo", status: "blocked" },
    { id: "p5", text: "waits", status: "open", waitUntil: new Date(now + 60 * MIN).toISOString() },
    { id: "p6", text: "parent", status: "doing", children: [{ id: "p7", text: "no job", status: "open" }] },
    { id: "p8", text: "done", status: "done" },
  ];
  const jobs = [job("a", "working"), job("b", "idle"), job("c", "idle")];
  const last = (j: Job) => (j.name === "c" ? now - 5 * MIN : now - 120 * MIN);
  const items = stalledSteps({ agent: theAgent, plan, todos: [{ id: "t1", text: "go?", done: false, from: "agent", step: "p4" }], jobs, now, seen: { "ag_x/p7": now - 600 * MIN }, last });
  assert.deepEqual(items.map(i => [i.sig, (now - i.at!) / MIN]), [["step:ag_x/p2", 300], ["step:ag_x/p7", 600]], "a step with a job is as old as its job");
});

test("a step whose idle job sleeps on a board.wake the app owes moves, and one whose idle job has no wake is stalled", () => {
  const plan = [
    { id: "p1", text: "job asleep on a wake", status: "doing", job: "a" },
    { id: "p2", text: "job with no wake", status: "doing", job: "b" },
    { id: "p3", text: "a work thread wake names it", status: "todo" },
  ];
  const jobs = [job("a", "idle", { id: "t:2", conversation: 2 }), job("b", "idle", { id: "t:3", conversation: 3 })];
  const last = () => now - 120 * MIN;
  const check = { kind: "check" as const, command: "true", every: 10 * MIN, at: now + 60 * MIN };
  const wakes = [
    { session: "t--2", note: "a: waits on staging", since: now - 150 * MIN, on: check },
    { session: "t--1", note: "p3: release lands", since: now - 150 * MIN, on: check },
  ];
  assert.deepEqual(stalledSteps({ agent: theAgent, plan, todos: [], jobs, now, seen: {}, last, wakes }).map(i => i.sig), ["step:ag_x/p2"]);
  assert.deepEqual(stalledSteps({ agent: theAgent, plan, todos: [], jobs, now, seen: {}, last }).map(i => i.sig), ["step:ag_x/p1", "step:ag_x/p2", "step:ag_x/p3"]);
});

test("a working job with no entry for 45 min is stuck, and a failure is listed for 24 h", () => {
  const jobs = [job("quiet", "working"), job("busy", "working"), job("broke", "failed"), job("old", "failed")];
  const last = (j: Job) => ({ quiet: now - 50 * MIN, busy: now - 2 * MIN, broke: now - 60 * MIN, old: now - 30 * 60 * MIN })[j.name];
  assert.deepEqual(jobFindings(jobs, last, now).map(i => [i.kind, i.sig]), [["job_stuck", "stuck:t:quiet"], ["job_failed", "failed:t:broke"]]);
});

test("a job pi-host flags as retrying reads retrying since, not stuck, while it works or sleeps", () => {
  const flag = "retrying since 08:22: pi-pool token hook lock_wait_timeout";
  const jobs = [{ ...job("retry", "sleeping"), retrying: flag }, { ...job("retry-work", "working"), retrying: flag }, job("quiet", "working")];
  const items = jobFindings(jobs, () => now - 60 * MIN, now);
  assert.deepEqual(items.map(i => [i.kind, i.sig]), [["job_retrying", "retrying:t:retry"], ["job_retrying", "retrying:t:retry-work"], ["job_stuck", "stuck:t:quiet"]]);
  assert.equal(items[0]!.text, `x job "retry" is ${flag}`);
  assert.match(items[0]!.context?.[0] ?? "", new RegExp(`ago, ${flag}$`));
  assert.ok(items.every(i => !(i.kind === "job_stuck" && i.sig.includes("retry"))), "a retrying job is never stuck");
});

test("an item is worth a look when new or last raised a day ago", () => {
  const item = (sig: string): Item => ({ kind: "duty_off", sig, agent: "x", text: sig, link: "#" });
  const first = worthALook([item("a"), item("b")], {}, now);
  assert.equal(first.fresh.length, 2);
  const second = worthALook([item("a"), item("c")], first.next, now + 180 * MIN);
  assert.deepEqual(second.fresh.map(i => i.sig), ["c"]);
  assert.deepEqual(Object.keys(second.next.raised ?? {}).sort(), ["a", "c"], "a fixed item leaves the state");
  assert.deepEqual(worthALook([item("a")], second.next, now + 24 * 60 * MIN).fresh.map(i => i.sig), ["a"]);
});

const dir = mkdtempSync(join(tmpdir(), "fable-sweep-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a job's newest entry time comes from its thread file", () => {
  const file = join(dir, "t.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL)");
  const add = db.prepare("INSERT INTO entries (conversation_id, commit_seq, record) VALUES (?, 0, ?)");
  add.run(2, JSON.stringify({ model: [{ role: "assistant", timestamp: 100 }] }));
  add.run(2, JSON.stringify({ model: [{ role: "toolResult", timestamp: 200 }] }));
  add.run(2, JSON.stringify({ kind: "agent.message" }));
  add.run(3, JSON.stringify({ model: [{ role: "assistant", timestamp: 900 }] }));
  db.close();
  assert.deepEqual([...lastEntries(file, [2, 4])], [[2, 200]]);
  assert.equal(lastEntries(join(dir, "missing.sqlite"), [2]).size, 0);
});

test("a sweep while the last sweep's job has had no model turn reads not measured, starts nothing and carries its items (11-24, 10:23 to 13:40 KST)", () => {
  const file = join(dir, "waiting.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL)");
  db.prepare("INSERT INTO entries (conversation_id, commit_seq, record) VALUES (1, 0, ?)").run(JSON.stringify({ kind: "agent.message", model: [{ role: "user" }] }));
  db.prepare("INSERT INTO tasks (conversation_id, kind, status, record) VALUES (1, 'pi.generation', 'sleeping', ?)").run(JSON.stringify({ state: { checkpoint: { handle: { data: { message: "waiting for an account slot" } } } } }));
  assert.equal(noModelTurn(file), true);
  db.prepare("INSERT INTO entries (conversation_id, commit_seq, record) VALUES (1, 0, ?)").run(JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant" }] }));
  assert.equal(noModelTurn(file), false, "a job that had its turn is measured as before");
  db.close();
  assert.equal(noModelTurn(join(dir, "missing.sqlite")), false);

  const items: Item[] = [{ kind: "duty_off", sig: "duty:a/d1", agent: "a", text: "t", link: "l" }];
  assert.deepEqual(worthALook(items, {}, now, false).next.raised, {}, "unraised, so the next run sees the item fresh");
  assert.equal(worthALook(items, worthALook(items, {}, now, false).next, now + 180 * MIN).fresh.length, 1);

  const metrics: DutyMetric[] = [
    { key: "findings_unposted", label: "unposted", op: "<=", target: 0, headline: true },
    { key: "sweep_age_min", label: "age", op: "<=", target: 195 },
  ];
  const judged = judge(metrics, { metrics: { sweep_age_min: 180 }, flagged: [{ kind: "outside_wait", excerpt: "the sweep job of 01:23Z has had no model turn" }] });
  assert.equal(judged.verdict, "error", "unmeasured, never met; the outside_wait gives the run waitsOn, so it starts no job and adds to no error streak");
  assert.equal(judged.metrics.findings_unposted, undefined);
  assert.match(judged.summary, /not measured: the precheck gave no value for findings_unposted \(the sweep job of 01:23Z has had no model turn\)/);
});

test("findings count as passed on once the DM has the agent's post or the job found nothing", () => {
  const since = now - 30 * MIN;
  const auditor = { id: "ag_fable-auditor", kind: "chat" };
  assert.equal(reportState({ dm: [reply("p1", 10, { author: auditor })], agent: auditor.id, since, answer: ["4 things"] }), "posted");
  assert.equal(reportState({ dm: [reply("p1", 40, { author: auditor })], agent: auditor.id, since, answer: ["4 things"] }), "pending", "a post before the run is an older sweep's");
  assert.equal(reportState({ dm: [post("p2", 10)], agent: auditor.id, since, answer: ["", "Nothing to report."] }), "nothing");
  assert.equal(reportState({ dm: [], agent: auditor.id, since, answer: ["", " "] }), "none");
});

test("a later empty turn does not hide the job's report", () => {
  const items = [{ kind: "turn", text: "4 things", sent: ["4 things"] }, { kind: "message", text: "[skill-route]" }, { kind: "turn", text: "" }];
  assert.deepEqual(answerOf(items), ["4 things", "4 things"]);
  assert.deepEqual(answerOf([{ kind: "turn", text: "nothing to report", live: true }]), []);
});

test("a duty whose newest run read error on an away box or an outside wait is not measured, so the sweep lists no item for it (5180 designer, 11-28)", () => {
  const at = now - 60 * MIN;
  assert.equal(notMeasured([{ at, verdict: "error", summary: "no value", hostAway: "mac" }, { at: at - 1, verdict: "missed" }]), "its box mac is away");
  assert.equal(notMeasured([{ at: at + 1, verdict: "skipped" }, { at, verdict: "error", waitsOn: "a paid proxy" }]), "it waits on a paid proxy");
  assert.equal(notMeasured([{ at, verdict: "error", summary: "the precheck failed" }]), undefined, "a broken precheck is still a finding");
  assert.equal(notMeasured([{ at, verdict: "missed", hostAway: "mac" }]), undefined, "a miss it measured is still a finding");
});

test("a duty's context is its last three measured runs, after-job measures first, and its fix steps", () => {
  const at = Date.parse("2026-11-22T00:00:00Z");
  const lines = dutyContext([
    { at, verdict: "missed", summary: "x 1", after: { verdict: "met", summary: "x 0" }, fixes: { x: { step: "p9", job: "fix x", live: true } } },
    { at: at - 1, verdict: "skipped", summary: "skipped: previous run still working" },
    { at: at - 2, verdict: "error", error: "Command failed" },
    { at: at - 3, verdict: "missed", summary: "x 2" },
    { at: at - 4, verdict: "missed", summary: "x 3" },
  ]);
  assert.deepEqual(lines, ["11-22 09:00 KST met: x 0", "11-22 08:59 KST error: Command failed", "11-22 08:59 KST missed: x 2", "x fix step p9, job fix x live"]);
});

test("a quiet job whose tree pi-pool parks for a model account is alive, not stuck, while its root task is terminal (11-27, 07:27 to 12:07 KST)", async () => {
  const jobs = [job("geonode", "working"), job("leftovers", "working"), job("polls", "working"), job("quiet", "working")].map(j => ({ ...j, thread: j.name }));
  const who = (slotAt: number | null) => ({ code: 0, err: "", out: JSON.stringify({ providers: { anthropic: { wait: slotAt === null ? null : { account: "7bec9951", slot_at: slotAt / 1000, reserved: true } } } }) });
  const slots: Record<string, number | null> = { geonode: now + 20 * MIN, leftovers: now + 10 * MIN, polls: null, quiet: now - MIN };
  const asked: string[][] = [];
  const read = (async (threads: readonly { session: string | null; model: string | null }[]) => {
    asked.push(threads.map(t => t.session ?? ""));
    return { at: now, queue: who(null), config: who(null), threads: new Map(threads.map(t => [`${t.session}|`, { who: who(slots[t.session!.replace("pi-durable:", "")]!), ls: {}, at: now }])) };
  }) as unknown as Parameters<typeof parkedJobs>[2];
  const parked = await parkedJobs(jobs, now, read);
  assert.deepEqual([...parked].sort(), ["t:geonode", "t:leftovers"]);
  assert.deepEqual(asked, [["pi-durable:geonode", "pi-durable:leftovers", "pi-durable:polls", "pi-durable:quiet"]], "one pool read, one tree per thread");
  const task = (j: Job) => j.name === "polls" ? "pi-host task sleeping: waiting for an account slot" : "pi-host task terminal";
  assert.deepEqual(jobFindings(jobs, () => now - 5 * 60 * MIN, now, task, parked).map(i => i.sig), ["stuck:t:quiet"]);
  assert.equal((await parkedJobs(jobs, now, (async () => { throw new Error("pi-pool failed"); }) as unknown as Parameters<typeof parkedJobs>[2])).size, 0);
});

const crawler = { id: "ag_crawler-guy", name: "Crawler guy", status: "idle", thread: "tc" };
const missedRun = (minutesAgo: number, job?: string, missed: string[] = ["proxy_kb_per_read"]): DutyRunView => ({ at: now - minutesAgo * MIN, verdict: "missed", summary: missed.join(", "),
  metrics: { sweep_age_min: { met: true }, ...Object.fromEntries(missed.map(key => [key, { met: false }])) }, ...(job ? { job: { id: `j:${job}`, name: job } } : {}) });
const crawlerJob = (name: string, status: string): Job => ({ id: `tc:${name}`, name, status, thread: "tc", conversation: 4, createdAt: now - 60 * MIN, agent: { id: crawler.id, name: crawler.name } });

test("a duty miss is passed on when each missed metric has its own fix step that moves, or on the duty's first run (Crawler guy d1 and d2, 11-24 15:00 KST)", () => {
  const plan: PlanItem[] = [{ id: "p5", text: "Whole pipeline", status: "blocked", children: [
    { id: "p48", text: "Bring a paid Instagram profile read back to 50 KB", status: "doing", duty: "d1/proxy_kb_per_read", job: "crawler ops train" },
    { id: "p50", text: "Crawler duties measure what they claim", status: "doing", duty: "d1/cpu_ms_per_read", job: "crawler duty prechecks" },
  ] }];
  const older = [missedRun(30, "Crawler read cost duty"), missedRun(200, "Crawler read cost duty")];
  const of = (runs: DutyRunView[], jobs: Job[], wakes = [] as Parameters<typeof passedOn>[0]["wakes"]) =>
    passedOn({ agent: crawler, dutyId: "d1", runs, plan, jobs, now, wakes });
  assert.equal(of(older, [crawlerJob("crawler ops train", "working")]), "proxy_kb_per_read fix step p48, job crawler ops train working");
  assert.equal(of(older, [crawlerJob("crawler duty prechecks", "sleeping")]), undefined, "p50 is for cpu_ms_per_read, which this run did not miss");
  assert.equal(of(older, [crawlerJob("crawler ops train", "idle")]), undefined, "an idle job with no wake moves nothing");
  const both = [missedRun(30, "c", ["proxy_kb_per_read", "cpu_ms_per_read"]), missedRun(200, "c")];
  assert.equal(of(both, [crawlerJob("crawler ops train", "working"), crawlerJob("crawler duty prechecks", "sleeping")]),
    "proxy_kb_per_read fix step p48, job crawler ops train working; cpu_ms_per_read fix step p50, job crawler duty prechecks sleeping");
  assert.equal(of(both, [crawlerJob("crawler ops train", "working")]), undefined, "every missed metric needs its own moving step");
  assert.equal(of([{ ...missedRun(30, "c"), after: { verdict: "missed", metrics: { cpu_ms_per_read: { met: false } } } }, missedRun(200, "c")], [crawlerJob("crawler ops train", "working")]),
    undefined, "the after-job measure's misses count");
  assert.equal(of([missedRun(30, "Crawler read cost duty 261124-150043")], []), "first run of the duty, its job Crawler read cost duty 261124-150043 has it");
  assert.equal(of([missedRun(30, "a"), { at: now - 60 * MIN, verdict: "skipped" }], []), "first run of the duty, its job a has it", "a skipped run measured nothing");
  assert.equal(passedOn({ agent: crawler, dutyId: "d2", runs: older, plan, jobs: [crawlerJob("crawler ops train", "working")], now }), undefined, "a step of another duty");
  const check = { kind: "check" as const, command: "true", every: 10 * MIN, at: now + 60 * MIN };
  assert.equal(of(older, [{ ...crawlerJob("crawler ops train", "idle"), id: "tc:4" }], [{ session: "tc--4", note: "crawler ops train: cut lands", since: now - 90 * MIN, on: check }]),
    "proxy_kb_per_read fix step p48, a board.wake or subagent moves it");

  // agent factory d2 on 11-24: its p235 for another metric had a working job, and its slowest_api_p90_ms step p155 had no job.
  const factory = { id: "ag_agent-factory", name: "agent factory", status: "idle", thread: "tf" };
  const factoryPlan: PlanItem[] = [
    { id: "p155", text: "slowest call under 1 s", status: "doing", duty: "d2/slowest_api_p90_ms" },
    { id: "p235", text: "pi-host loop stalls", status: "doing", duty: "d2/thread_open_p90_ms", job: "pi-host loop stalls" },
  ];
  const factoryRuns = [missedRun(30, "s", ["slowest_api_p90_ms"]), missedRun(200, "s", ["slowest_api_p90_ms"])];
  const stalls: Job = { ...crawlerJob("pi-host loop stalls", "sleeping"), agent: { id: factory.id, name: factory.name } };
  assert.equal(passedOn({ agent: factory, dutyId: "d2", runs: factoryRuns, plan: factoryPlan, jobs: [stalls], now }), undefined, "a step for another metric covers nothing");

  // agent factory d2 at 10:24 KST 11-25: p155 slept on the work thread's wake, and p278 and p279 were closed while its wake still named them.
  const threeRuns = [missedRun(30, "s", ["slowest_api_p90_ms", "search_p90_ms", "thread_open_p90_ms"]), missedRun(200, "s", ["slowest_api_p90_ms"])];
  const d2Plan = (status: PlanItem["status"]): PlanItem[] => [
    { id: "p155", text: "slowest call under 1 s", status: "doing", duty: "d2/slowest_api_p90_ms", job: "sw factory stays snappy duty 261124-200357" },
    { id: "p278", text: "room opens at once", status, duty: "d2/thread_open_p90_ms" },
    { id: "p279", text: "fast search", status, duty: "d2/search_p90_ms", job: "search speed" },
  ];
  const workWake = (note: string) => ({ session: "tf--1", note, since: now - 90 * MIN, on: check });
  const wakes155 = [workWake("p155: a stored speed check reads the slowest call at or under 1,000 ms"), workWake("p278 and p279: their fixes are live")];
  const d2 = (status: PlanItem["status"], wakes: Parameters<typeof passedOn>[0]["wakes"] = wakes155) =>
    ({ agent: factory, dutyId: "d2", runs: threeRuns, plan: d2Plan(status), jobs: [], now, wakes });
  assert.equal(passedOn(d2("done")), undefined, "a closed step covers nothing, even while a wake names it");
  assert.equal(unmovedMetrics(d2("done")), "not passed on: no fix step a job, board.wake or subagent moves for search_p90_ms, thread_open_p90_ms",
    "the item names the metrics no step moves, not only p155");
  assert.equal(passedOn(d2("doing")), "slowest_api_p90_ms fix step p155, a board.wake or subagent moves it; " +
    "search_p90_ms fix step p279, a board.wake or subagent moves it; thread_open_p90_ms fix step p278, a board.wake or subagent moves it");
  assert.equal(unmovedMetrics(d2("doing")), undefined);
  assert.equal(unmovedMetrics(d2("doing", wakes155.slice(0, 1))), "not passed on: no fix step a job, board.wake or subagent moves for search_p90_ms, thread_open_p90_ms");
  assert.equal(passedOn(d2("doing", [workWake("p155: x"), { ...workWake("p278 and p279: x"), session: "tc--1" }])), undefined, "another thread's wake names nothing of this agent");

  const items: Item[] = [
    { kind: "duty_off", sig: "duty:ag_crawler-guy/d1", agent: "Crawler guy", text: "d1", link: "#", passedOn: "fix step p48" },
    { kind: "duty_off", sig: "duty:ag_seo/d1", agent: "seo", text: "seo d1", link: "#" },
  ];
  const looked = worthALook(items, {}, now);
  assert.deepEqual(looked.fresh.map(i => i.sig), ["duty:ag_seo/d1"], "a passed-on item is never fresh");
  assert.deepEqual(Object.keys(looked.next.raised ?? {}), ["duty:ag_seo/d1"], "nor raised, so it shows once its step closes with the miss still there");
});

test("a duty miss whose fix steps wait on an open For you todo is passed on, as d9 reads it, and a step it holds is not stalled (CRM developer VP d4, 11-28 07:30 KST)", () => {
  const crm = { id: "ag_crm-developer-vp", name: "CRM developer VP", status: "idle", thread: "tcrm" };
  const plan: PlanItem[] = [
    { id: "p17", text: "Answer the 17 customer live chats that got no reply", status: "blocked", job: "support inbox", duty: "d4/unanswered_chats_24h" },
    { id: "p25", text: "Bring the oldest unanswered customer chat under a day", status: "blocked", duty: "d4/oldest_unanswered_chat_hours", waitFor: "t8" },
  ];
  const runs = [missedRun(30, "inbox", ["unanswered_chats_24h", "oldest_unanswered_chat_hours"]), missedRun(200, "inbox")];
  const t8 = { id: "t8", text: "Send these 17 replies to customers?", done: false, from: "agent" as const, step: "p17" };
  const idle: Job = { id: "tcrm:5", name: "support inbox", status: "idle", thread: "tcrm", conversation: 5, createdAt: now - 2000 * MIN, agent: { id: crm.id, name: crm.name } };
  type Todos = NonNullable<Parameters<typeof passedOn>[0]["todos"]>;
  const miss = (todos: Todos) => ({ agent: crm, dutyId: "d4", runs, plan, todos, jobs: [idle], now });
  assert.equal(passedOn(miss([t8])), "unanswered_chats_24h fix step p17, held for the owner by t8; oldest_unanswered_chat_hours fix step p25, held for the owner by t8");
  assert.equal(unmovedMetrics(miss([t8])), undefined);
  assert.equal(passedOn(miss([{ ...t8, done: true }])), undefined, "an answered todo holds nothing");
  assert.equal(unmovedMetrics(miss([{ ...t8, done: true }])), "not passed on: no fix step a job, board.wake or subagent moves for unanswered_chats_24h, oldest_unanswered_chat_hours");
  const steps = (todos: Todos) => stalledSteps({ agent: crm, plan: [plan[0]!], todos, jobs: [idle], now, seen: {}, last: () => now - 2000 * MIN });
  assert.deepEqual(steps([t8]), [], "a step an open todo links is the owner's");
  assert.deepEqual(steps([{ id: "t8", text: "Send the p17 replies?", done: false, from: "agent" }]), [], "a todo that names the step's id links it too, as d9 reads it");
  assert.deepEqual(steps([{ ...t8, done: true }]).map(i => i.sig), ["step:ag_crm-developer-vp/p17"]);
});

test("a verify run confirms the last sweep and raises nothing; scheduled runs mark, after and peek runs do not", () => {
  assert.deepEqual(sweepMode("run", "verify"), { mode: "run", confirm: true, mark: false });
  assert.deepEqual(sweepMode("run", "schedule"), { mode: "run", confirm: false, mark: true });
  assert.deepEqual(sweepMode(undefined, undefined), { mode: "run", confirm: false, mark: true });
  assert.deepEqual(sweepMode("after", undefined), { mode: "after", confirm: true, mark: false });
  assert.deepEqual(sweepMode("peek", "verify"), { mode: "peek", confirm: false, mark: false });
});

/**
 * The 11-24 15:32 KST case through the duty runner and the real precheck: the auditor closed its fix step after its 13:24 sweep's report
 * reached the DM, and the board's verify run found Crawler guy's two first-run misses, both with working fix jobs, and one older miss nobody
 * has. The verify run reads 0 and starts no job; the next scheduled run counts the one item nobody has.
 */
test("a verify run after a posted sweep reads met with no job, and passed-on misses never count (11-24 15:32 KST)", async () => {
  delete process.env.INVOCATION_ID;
  const live = Date.now();
  const sweepAt = live - 130 * MIN;
  const auditor = { id: "ag_fable-auditor", name: "fable auditor", status: "idle", thread: "ta", room: "dm_fable-auditor" };
  const run = (id: string, minutesAgo: number, job?: string) => ({ at: live - minutesAgo * MIN, verdict: "missed", summary: `${id} missed`, metrics: { proxy_kb_per_read: { met: false } },
    ...(job ? { job: { id: `j-${job}`, name: job } } : {}) });
  const routes: Record<string, unknown> = {
    "/api/agents": [auditor, crawler, { id: "ag_seo", name: "seo", status: "idle", thread: "ts" }],
    "/api/jobs": [{ ...crawlerJob("crawler ops train", "working"), createdAt: live - 20 * MIN }],
    "/api/search/recent": { hits: [] },
    "/api/agents/ag_crawler-guy/board": { board: { todos: [], plan: [{ id: "p48", text: "read KB", status: "doing", duty: "d1/proxy_kb_per_read", job: "crawler ops train" }] } },
    "/api/agents/ag_crawler-guy/duties": { duties: [
      { duty: { id: "d1", name: "Crawler read cost" }, paused: false, last: { verdict: "missed", at: live - 32 * MIN, streak: 2 }, runs: [run("d1", 32, "cost 1"), run("d1", 200, "cost 0")] },
      { duty: { id: "d2", name: "GeoNode proxy use" }, paused: false, last: { verdict: "missed", at: live - 32 * MIN, streak: 1 }, runs: [run("d2", 32, "GeoNode proxy use duty")] },
    ] },
    "/api/agents/ag_seo/board": { board: { todos: [], plan: [] } },
    "/api/agents/ag_seo/duties": { duties: [
      { duty: { id: "d1", name: "Search traffic" }, paused: false, last: { verdict: "missed", at: live - 60 * MIN, streak: 2 }, runs: [run("seo", 60, "t1"), run("seo", 1500, "t0")] },
      { duty: { id: "d2", name: "Area review" }, paused: false, last: { verdict: "error", at: live - 60 * MIN, streak: 0 },
        runs: [{ at: live - 60 * MIN, verdict: "error", summary: "the precheck gave no value for corrections_unsaved", metrics: {}, hostAway: "mac" }, run("seo", 1500, "t0")] },
    ] },
    "/api/agents/ag_fable-auditor/board": { board: null },
    "/api/agents/ag_fable-auditor/duties": { duties: [] },
    "/api/c/dm_fable-auditor/items": { items: [{ id: "p1", at: sweepAt + 60 * MIN, author: { id: auditor.id, kind: "chat" }, text: "2 things" }] },
    "/api/c/j-sweep/items": { items: [{ kind: "turn", text: "2 things", sent: ["2 things"] }] },
  };
  const server = createServer((req, res) => {
    const body = routes[new URL(req.url ?? "/", "http://x").pathname];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" }).end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const work = mkdtempSync(join(tmpdir(), "fable-sweep-verify-"));
  try {
    const appDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const spec = JSON.parse(readFileSync(join(appDir, "scripts/duties/fable-sweep.duty.json"), "utf8")) as Omit<Duty, "id">;
    const duty = { ...spec, id: "d1", precheck: { ...spec.precheck, cwd: appDir, command: [...spec.precheck.command, "--server", `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      "--threads-dir", join(work, "threads"), "--data-dir", join(work, "data")] } } as Duty;
    const state = JSON.stringify({ raised: { "duty:ag_seo/d1": sweepAt - 1500 * MIN }, seen: {}, lastRun: { at: sweepAt, fresh: 2 } });
    writeFileSync(join(work, "d1.state.json"), state);
    const sweep = { duty: "d1", at: sweepAt, slot: sweepAt, trigger: "schedule", ms: 1, verdict: "missed", summary: "findings_unposted 2", job: { id: "j-sweep", name: "Everything at a glance duty" },
      metrics: { findings_unposted: { value: 2, target: 0, op: "<=", met: false }, sweep_age_min: { value: 180, target: 195, op: "<=", met: true } } } as DutyRunRecord;
    const measureAs = (trigger: "verify" | "schedule") => measure({ duty, chat: { id: "ag_fable-auditor", name: "fable auditor" }, dir: work, trigger, previous: [sweep],
      board: null, liveJob: () => false, boardApi: "http://x", now: Date.now() });

    const verify = await measureAs("verify");
    assert.equal(verify.record.verdict, "met", verify.record.summary);
    assert.equal(verify.record.metrics.findings_unposted?.value, 0, "the 13:24 sweep's report is in the DM");
    assert.equal(verify.brief, null, "no new sweep job");
    assert.equal(readFileSync(join(work, "d1.state.json"), "utf8"), state, "a verify run raises nothing");

    const scheduled = await measureAs("schedule");
    assert.equal(scheduled.record.metrics.findings_unposted?.value, 1, "only seo d1, which nobody has; Crawler guy's d1 and d2 are passed on");
    const detail = JSON.parse(readFileSync(scheduled.record.detail!, "utf8")) as { n: Record<string, number>; items: (Item & { fresh: boolean })[] };
    assert.deepEqual(detail.n, { agents: 3, posts: 0, jobs: 1, duties: 4, dutiesNotMeasured: 1, steps: 1, poolWaits: 0 }, "n counts each kind the sweep read");
    const items = detail.items;
    assert.deepEqual(items.map(i => [i.sig, i.fresh, i.passedOn]).sort(), [
      ["duty:ag_crawler-guy/d1", false, "proxy_kb_per_read fix step p48, job crawler ops train working"],
      ["duty:ag_crawler-guy/d2", false, "first run of the duty, its job GeoNode proxy use duty has it"],
      ["duty:ag_seo/d1", true, undefined],
    ]);
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});

/**
 * The 11-28 case through the real precheck in peek mode: the sweep flagged agent factory for the Fable 5.2 the owner had set from his page at
 * 19:19 KST. The server says who set an agent's current model (`AgentSummary.modelSet`), and only a Fable agent with no owner record is an item.
 */
test("a Fable work thread the owner set himself is no item, and one an agent or a job set still is (agent factory, 11-28 19:19 KST)", async () => {
  const fable = { provider: "anthropic", id: "claude-fable-5-2", label: "Fable 5.2" };
  const one = (slug: string, extra: Record<string, unknown> = {}) => ({ id: `ag_${slug}`, name: slug, status: "idle", thread: `t-${slug}`, room: `dm_${slug}`, model: fable, ...extra });
  const routes: Record<string, unknown> = {
    "/api/agents": [
      one("fable-auditor"), one("agent-factory", { modelSet: { by: "owner", at: Date.parse("2026-11-28T10:19:17Z") } }), one("vent"),
      one("seo", { model: { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5" } }),
    ],
    "/api/jobs": [], "/api/search/recent": { hits: [] },
  };
  const server = createServer((req, res) => {
    const body = routes[new URL(req.url ?? "/", "http://x").pathname];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" }).end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const work = mkdtempSync(join(tmpdir(), "fable-sweep-model-"));
  try {
    const out = join(work, "peek.json");
    await promisify(execFile)("node", ["--import", "tsx", "scripts/duties/fable-sweep.ts", "--agent", "ag_fable-auditor", "--server", `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      "--threads-dir", join(work, "threads"), "--data-dir", join(work, "data")], { cwd: join(dirname(fileURLToPath(import.meta.url)), "../.."), env: { ...process.env, PRECHECK_MODE: "peek", OUTPUT_FILE: out } });
    const { items } = JSON.parse(readFileSync(out, "utf8")) as { items: Item[] };
    assert.deepEqual(items.filter(item => item.kind === "model_off").map(item => [item.sig, item.agent]), [["model:ag_vent/claude-fable-5-2", "vent"]]);
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});
