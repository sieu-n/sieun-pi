/**
 * `scripts/duties/fable-sweep.ts`, the fable auditor's 3-hourly sweep:
 * 1. An owner post counts as answered once an agent posts after it in its scope, a later answered post of his covers it, or a reaction
 *    other than 👀 says it all; a post that reached no agent in a channel is a delivery error.
 * 2. A step is stalled only when no live job, running wait, open todo or recent job entry moves it.
 * 3. A working job with no entry for 45 min is stuck, and a job that failed in the last 24 h is listed.
 * 4. An item is worth a look when it is new or was last raised 24 h ago, so a quiet run starts no job.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { jobFindings, lastEntries, postFindings, stalledSteps, worthALook, type Item, type Job, type Post } from "../../scripts/duties/fable-sweep.ts";

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
