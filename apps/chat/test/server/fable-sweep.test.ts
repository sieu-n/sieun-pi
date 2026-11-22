/**
 * `scripts/duties/fable-sweep.ts`, the fable auditor's 3-hourly sweep:
 * 1. An owner post counts as answered once an agent posts after it in its scope, a later answered post of his covers it, or a reaction
 *    other than 👀 says it all; a post that reached no agent in a channel is a delivery error.
 * 2. A step is stalled only when no live job, running wait, open todo or recent job entry moves it.
 * 3. A working job with no entry for 45 min is stuck, and a job that failed in the last 24 h is listed.
 * 4. An item is worth a look when it is new or was last raised 24 h ago, so a quiet run starts no job.
 * 5. A sweep's findings count as passed on once the agent posts in its DM after the run or its job answered "nothing to report"; a sweep
 *    that finds things is the duty working, so after mode reads 0 then (c67).
 * 6. Each item carries what a reviewer needs to judge it, so the Fable turn reads one file: a duty's last three runs and fix step, and three or
 *    more jobs that wait for a model account as one item.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { answerOf, dutyContext, jobFindings, lastEntries, poolWaits, postFindings, reportState, stalledSteps, worthALook, type Item, type Job, type Post } from "../../scripts/duties/fable-sweep.ts";

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
  const items = stalledSteps({ agent: theAgent, plan, todos: [{ id: "t1", step: "p4" }], jobs, now, seen: { "ag_x/p7": now - 600 * MIN }, last });
  assert.deepEqual(items.map(i => [i.sig, (now - i.at!) / MIN]), [["step:ag_x/p2", 300], ["step:ag_x/p7", 600]], "a step with a job is as old as its job");
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

test("three or more jobs that wait for a model account fold into one item, and fewer stay apart", () => {
  const waiting = (n: number): Item => ({ kind: "job_stuck", sig: `stuck:j${n}`, agent: `a${n % 2}`, text: `a job "j${n}" reads working with no new entry for 1 h, waiting for a model account`, link: `#/c/j${n}`, at: now - n * MIN });
  const other: Item = { kind: "job_stuck", sig: "stuck:k", agent: "b", text: `b job "k" reads working with no new entry for 2 h`, link: "#/c/k", at: now };
  assert.equal(poolWaits([waiting(1), waiting(2), other], now).length, 3);
  const folded = poolWaits([waiting(1), waiting(2), waiting(3), other], now);
  assert.deepEqual(folded.map(item => item.sig), ["stuck:k", "stuck:pool"]);
  assert.equal(folded[1]!.text, "3 jobs wait for a model account, the oldest with no new entry for 3 min");
  assert.equal(folded[1]!.context?.length, 3);
});
