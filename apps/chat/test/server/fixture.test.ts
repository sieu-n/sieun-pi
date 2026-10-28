/**
 * The chat server through a plain HTTP and WebSocket client, on the fixture host.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/fixture.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, SearchResult, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start({ wordMs: 2 });
});
after(async () => {
  await s.close();
});

const turnText = (page: TimelinePage) => page.items.filter(i => i.kind === "turn").map(i => (i as Extract<Item, { kind: "turn" }>).text);

describe("conversations", () => {
  test("the sidebar groups solo threads, channels and DMs", async () => {
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.deepEqual(sidebar.solo.map(c => c.name).sort(), ["AI harness developer environment VP", "Crawler VP", "Vent", "frontend bro"]);
    assert.deepEqual(sidebar.channels.map(c => c.name), ["general", "pi-cutover"]);
    assert.ok(sidebar.dms.some(c => c.name === "pi cutover prep"));
    assert.ok(sidebar.dms.some(c => c.id.startsWith(`${ids.vent}:`)));
    assert.equal(sidebar.forYou, 4);
    assert.ok(!sidebar.solo.some(c => c.name === "old relay probe"), "archived threads stay out");
  });

  test("a thread page has turns with tool steps, an image and a job pill", async () => {
    const page = await s.get<TimelinePage>(`/api/c/${ids.vent}/items`);
    const first = page.items[1] as Extract<Item, { kind: "turn" }>;
    assert.equal(first.kind, "turn");
    assert.deepEqual(first.steps.map(st => st.kind === "tool" ? st.name : st.kind), ["thinking", "bash", "read"]);
    assert.ok(page.items.some(i => i.kind === "message" && i.images.length === 1));
    const spawning = page.items.find(i => i.kind === "turn" && i.jobs.length) as Extract<Item, { kind: "turn" }>;
    assert.match(spawning.jobs[0]!.conversation, new RegExp(`^${ids.vent}:\\d+$`));
    const image = await fetch(s.base + (page.items.find(i => i.kind === "message" && i.images.length) as Extract<Item, { kind: "message" }>).images[0]!.url);
    assert.equal(image.headers.get("content-type"), "image/png");
  });

  test("a job's transcript starts with its parent's task", async () => {
    const job = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id.startsWith(`${ids.vent}:`))!;
    const page = await s.get<TimelinePage>(`/api/c/${encodeURIComponent(job.id)}/items`);
    assert.equal(page.items[0]!.kind === "message" && page.items[0]!.author.name, "Vent");
    assert.match(turnText(page)[0]!, /Two relay errors/);
  });

  test("after a turn returns only what came after the whole turn", async () => {
    const page = await s.get<TimelinePage>(`/api/c/${ids.vent}/items`);
    const lastTurn = page.items.filter(i => i.kind === "turn").at(-1)!;
    const after = await s.get<TimelinePage>(`/api/c/${ids.vent}/items?after=${lastTurn.id}`);
    assert.deepEqual(after.items.map(i => i.id), []);
    const fromInput = await s.get<TimelinePage>(`/api/c/${ids.vent}/items?after=${page.items[0]!.id}`);
    assert.equal(fromInput.items[0]!.id, page.items[1]!.id);
  });

  test("older pages start at an input, so no turn splits", async () => {
    const page = await s.get<TimelinePage>(`/api/c/${ids.vent}/items?limit=3`);
    assert.ok(page.older);
    assert.equal(page.items[0]!.kind, "message");
    const older = await s.get<TimelinePage>(`/api/c/${ids.vent}/items?before=${page.older}&limit=3`);
    assert.equal(older.items[0]!.kind, "message");
    assert.ok(older.items.at(-1)!.at <= page.items[0]!.at);
  });
});

describe("live turns", () => {
  test("a send streams partial text, then the turn, then idle", async () => {
    (s.host as any).wordMs = 30;
    const live = await s.live();
    live.watch(ids.frontend);
    await live.waitFor(e => e.type === "status" && e.conversation === ids.frontend);
    const sent = await s.send("POST", `/api/c/${ids.frontend}/send`, { text: "tell me about the canary", requestId: "live-1" });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.item.pending, true);
    await live.waitFor(e => e.type === "partial" && e.conversation === ids.frontend && !!e.partial?.text);
    const done = await live.waitFor(e => e.type === "items" && e.items.some(i => i.kind === "turn" && !i.live && i.text.includes("tell me about the canary")));
    assert.equal(done.type, "items");
    await live.waitFor(e => e.type === "status" && e.conversation === ids.frontend && e.status === "idle");
    const again = await s.send("POST", `/api/c/${ids.frontend}/send`, { text: "tell me about the canary", requestId: "live-1" });
    assert.equal(again.status, 200);
    (s.host as any).wordMs = 2;
    live.close();
  });

  test("a waiting send carries its queue place until the run starts", async () => {
    (s.host as any).wordMs = 5;
    const live = await s.live();
    live.watch(ids.frontend);
    await live.waitFor(e => e.type === "status" && e.conversation === ids.frontend);
    const sent = await s.send("POST", `/api/c/${ids.frontend}/send`, { text: "queue this one", requestId: "queue-1" });
    assert.deepEqual(sent.body.queue, { state: "queued", position: 3, total: 7 });
    assert.deepEqual(sent.body.item.queue, { state: "queued", position: 3, total: 7 });
    const header = await s.get(`/api/c/${ids.frontend}`);
    assert.equal(header.queue.state, "queued");
    await live.waitFor(e => e.type === "queue" && e.conversation === ids.frontend && e.place === null, 15_000);
    await live.waitFor(e => e.type === "items" && e.items.some(i => i.kind === "turn" && i.text.includes("queue this one")), 15_000);
    (s.host as any).wordMs = 2;
    live.close();
  });

  test("a job's live transcript keeps its parent as the author of the task", async () => {
    const job = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id.startsWith(`${ids.vent}:`))!;
    const live = await s.live();
    live.watch(job.id);
    await s.send("POST", `/api/c/${encodeURIComponent(job.id)}/send`, { text: "one more check", requestId: "job-live-1" });
    const event = await live.waitFor(e => e.type === "items" && e.conversation === job.id && e.items.some(i => i.kind === "turn" && i.text.includes("one more check")));
    assert.ok(event.type === "items" && event.items.every(i => i.kind !== "message" || i.text !== "Read the canary logs from the last day and list every relay error" || i.author.name === "Vent"));
    const page = await s.get<TimelinePage>(`/api/c/${encodeURIComponent(job.id)}/items?around=e15`);
    assert.equal(page.items[0]!.kind === "message" && page.items[0]!.author.name, "Vent");
    live.close();
  });

  test("Stop ends a running turn as aborted", async () => {
    (s.host as any).wordMs = 30;
    const live = await s.live();
    live.watch(ids.vent);
    await s.send("POST", `/api/c/${ids.vent}/send`, { text: "slow answer please", requestId: "stop-1" });
    await live.waitFor(e => e.type === "partial" && e.conversation === ids.vent && !!e.partial?.text);
    const stopped = await s.send("POST", `/api/c/${ids.vent}/abort`);
    assert.equal(stopped.status, 200);
    await live.waitFor(e => e.type === "items" && e.items.some(i => i.kind === "turn" && i.stop === "aborted"));
    (s.host as any).wordMs = 2;
    live.close();
  });

  test("a spawned job shows in the tree and as a pill", async () => {
    const live = await s.live();
    live.watch(ids.frontend);
    await s.send("POST", `/api/c/${ids.frontend}/send`, { text: "spawn a job for the relay", requestId: "spawn-1" });
    const jobs = await live.waitFor(e => e.type === "jobs" && e.thread === ids.frontend && e.jobs.length > 1);
    assert.equal(jobs.type === "jobs" && jobs.jobs[1]!.parent, ids.frontend);
    const page = await until(() => s.get<TimelinePage>(`/api/c/${ids.frontend}/items`), p => p.items.some(i => i.kind === "turn" && i.jobs.length > 0));
    const pill = page.items.find(i => i.kind === "turn" && i.jobs.length) as Extract<Item, { kind: "turn" }>;
    assert.match(pill.jobs[0]!.name, /canary relay/);
    const agents = await s.get<any[]>("/api/agents");
    assert.ok(agents.some(a => a.id === pill.jobs[0]!.conversation && a.kind === "job" && a.parent.id === ids.frontend));
    live.close();
  });
});

describe("channels and mentions", () => {
  test("a mention routes to the agent and its answer comes back into the thread", async () => {
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "@frontend bro is the relay page fine?", mentions: [ids.frontend], requestId: "mention-1" });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.deliveries[0].state, "delivered");
    const thread = await until(() => s.get(`/api/c/${ids.cutoverChannel}/replies/${sent.body.item.id}`), t => t.items.length > 0);
    assert.equal(thread.items[0].author.id, ids.frontend);
    assert.equal(thread.root.deliveries[0].state, "answered");
    assert.equal(thread.root.thread.replies, 1);
    const entries = await s.get<TimelinePage>(`/api/c/${ids.frontend}/items`);
    assert.ok(entries.items.some(i => i.kind === "message" && i.author.id === "owner" && i.text.startsWith("[#pi-cutover · post")));
  });

  test("a mention of a non-member is refused", async () => {
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "@Vent hi", mentions: [ids.vent], requestId: "mention-2" });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /Vent is not in #pi-cutover/);
  });

  test("channels create, add members and keep read marks", async () => {
    const created = await s.send("POST", "/api/channels", { name: "#Relay Ops", purpose: "relay", members: [ids.vent] });
    assert.equal(created.body.name, "relay-ops");
    const added = await s.send("POST", `/api/channels/${created.body.id}/members`, { agents: [ids.crawler] });
    assert.deepEqual(added.body.members.map((m: any) => m.principal.id), ["owner", ids.vent, ids.crawler]);
    const read = await s.send("POST", `/api/c/${ids.cutoverChannel}/read`, {});
    assert.equal(read.status, 200);
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.equal(sidebar.channels.find(c => c.id === ids.cutoverChannel)!.hasNew, false);
  });
});

describe("search", () => {
  test("totals are exact and the filters narrow them", async () => {
    const all = await s.get<SearchResult>("/api/search?q=relay&limit=5");
    assert.equal(all.hits.length, 5);
    assert.ok(all.total > 5);
    assert.equal(all.nextCursor, "5");
    const owner = await s.get<SearchResult>("/api/search?q=relay%20from:owner&limit=100");
    assert.equal(owner.total, owner.hits.length);
    assert.ok(owner.hits.every(h => h.author.id === "owner"));
    const channel = await s.get<SearchResult>(`/api/search?q=relay&in=${ids.cutoverChannel}`);
    assert.ok(channel.hits.every(h => h.conversation.id === ids.cutoverChannel && /^p\d+$/.test(h.messageId)));
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const recent = await s.get<SearchResult>(`/api/search?q=relay&after=${today}&limit=100`);
    assert.ok(recent.hits.every(h => h.at >= Date.parse(`${today}T00:00:00+09:00`)));
    assert.ok(all.hits.every(h => !/<(?!\/?mark>)/.test(h.snippet)));
  });

  test("a hit's messageId opens the page around it", async () => {
    const result = await s.get<SearchResult>(`/api/search?q=ECONNREFUSED&limit=10`);
    const hit = result.hits.find(h => h.kind === "turn")!;
    const page = await s.get<TimelinePage>(`/api/c/${encodeURIComponent(hit.conversation.id)}/items?around=${hit.messageId}`);
    assert.equal(page.focus, hit.messageId);
    assert.ok(page.items.some(i => i.id === hit.messageId));
  });
});

describe("boards", () => {
  test("the owner's answer changes the board, For you and reaches the chat", async () => {
    const view = await s.get(`/api/threads/${ids.harness}/board`);
    assert.equal(view.board.rev, 7);
    assert.ok(Array.isArray(view.awaitingGo));
    const live = await s.live();
    const answered = await s.send("POST", `/api/threads/${ids.harness}/board`, { ops: [{ op: "todo_update", id: "t1", reply: "Thursday 09:00", done: true }] });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.board.todos.find((t: any) => t.id === "t1").reply, "Thursday 09:00");
    await live.waitFor(e => e.type === "board" && e.chatId === ids.harness);
    const forYou = await s.get("/api/for-you");
    assert.equal(forYou.items.find((i: any) => i.todo.id === "t1" && i.chatId === ids.harness).todo.done, true);
    const page = await until(() => s.get<TimelinePage>(`/api/c/${ids.harness}/items?limit=200`), p => p.items.some(i => i.kind === "message" && i.text.startsWith("[board]")));
    assert.ok(page);
    live.close();
  });

  test("a moved Prime chat gets its board, duties, runs and check-in interval in one call", async () => {
    const prime = mkdtempSync(join(tmpdir(), "prime-chat-"));
    const id = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
    mkdirSync(join(prime, "boards"));
    mkdirSync(join(prime, "duties"));
    const board = { v: 2, rev: 3, updatedAt: new Date().toISOString(), plan: [{ id: "p1", text: "Moved step", status: "doing", children: [] }], todos: [{ id: "t1", text: "Moved ask", done: false, from: "agent", at: new Date().toISOString() }] };
    writeFileSync(join(prime, "boards", `${id}.json`), JSON.stringify(board));
    const duty = { id: "d1", name: "Moved duty", ownerWords: "keep it", goal: "it holds", metrics: [{ key: "up", label: "Up", op: ">=", target: 99, headline: true }],
      schedule: { kind: "daily", at: "07:00" }, precheck: { command: ["true"], cwd: "/", timeoutMs: 1000 }, onMiss: "fix", status: "active", createdAt: 1, updatedAt: 1, runCount: 2 };
    writeFileSync(join(prime, "duties", `${id}.json`), JSON.stringify({ version: 1, duties: [duty], checkIn: { createdAt: 1, runCount: 4, lastRunAt: 5 } }));
    const run = (at: number, value: number) => JSON.stringify({ duty: "d1", at, trigger: "schedule", ms: 1, verdict: value >= 99 ? "met" : "missed", metrics: { up: { value, target: 99, op: ">=", met: value >= 99 } }, summary: "" });
    writeFileSync(join(prime, "duties", `${id}.runs.jsonl`), [run(10, 100), run(20, 90), JSON.stringify({ duty: "checkin", at: 30, verdict: "met", metrics: {} })].join("\n"));
    writeFileSync(join(prime, "check-in-settings.json"), JSON.stringify({ [id]: { everyMs: 21_600_000 } }));
    s.app.config.sharedDir = prime;
    const result = await s.send("POST", `/api/threads/${ids.frontend}/import-prime`, { prime: id });
    assert.deepEqual(result.body, { board: true, duties: 1, runs: 2, checkInMs: 21_600_000 });
    const view = await s.get(`/api/threads/${ids.frontend}/board`);
    assert.equal(view.board.plan[0].text, "Moved step");
    const duties = await s.get(`/api/threads/${ids.frontend}/duties`);
    assert.equal(duties.duties[0].last.verdict, "missed");
    assert.equal((await s.get(`/api/threads/${ids.frontend}/check-in`)).everyMs, 21_600_000);
    assert.ok((await s.get("/api/for-you")).items.some((i: any) => i.chatId === ids.frontend && i.todo.text === "Moved ask"));
  });

  test("a duty run runs its precheck, records the judged run, and a miss starts a duty job whose answer reaches the chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duty-"));
    const file = join(s.app.store.dir, "boards", ids.frontend, "duties.json");
    mkdirSync(join(s.app.store.dir, "boards", ids.frontend), { recursive: true });
    const script = `const fs = require("fs"); const seen = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); ` +
      `fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ runs: (seen.runs ?? 0) + 1 })); ` +
      `fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: (seen.runs ?? 0) === 0 ? 90 : 100 }, flagged: [] }))`;
    const duty = { id: "d9", name: "Spec uptime", ownerWords: "keep it up", goal: "it stays up", metrics: [{ key: "up", label: "Up", op: ">=", target: 99, headline: true }],
      schedule: { kind: "daily", at: "07:00" }, precheck: { command: ["node", "-e", script], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active", createdAt: Date.now(), updatedAt: Date.now(), lastRunAt: Date.now(), runCount: 0 };
    writeFileSync(file, JSON.stringify({ duties: [duty], runs: {} }));
    const ran = await s.send("POST", `/api/threads/${ids.frontend}/duties`, { duty: "d9", action: "run" });
    assert.equal(ran.status, 200);
    const missed = await until(() => s.get(`/api/threads/${ids.frontend}/duties`), v => v.duties[0].runs.length === 1);
    const run = missed.duties[0].runs[0];
    assert.equal(run.verdict, "missed");
    assert.equal(run.metrics.up.value, 90);
    assert.match(run.job.name, /^Spec uptime duty /);
    const agents = await s.get<any[]>("/api/agents");
    assert.equal(agents.find(a => a.id === run.job.id).parent.id, ids.frontend);
    await until(() => s.get<TimelinePage>(`/api/c/${ids.frontend}/items?limit=200`), p => p.items.some(i => i.kind === "message" && i.text.startsWith("[duty d9]") && i.author.id === run.job.id));
    await s.send("POST", `/api/threads/${ids.frontend}/duties`, { duty: "d9", action: "run" });
    const met = await until(() => s.get(`/api/threads/${ids.frontend}/duties`), v => v.duties[0].runs.length === 2);
    assert.equal(met.duties[0].runs[0].verdict, "met");
    assert.equal(met.duties[0].runs[0].job, undefined, "a met run with nothing flagged starts no job");
  });

  test("an agent's board op through the API applies as the agent", async () => {
    const result = await s.send("POST", `/api/threads/${ids.harness}/board`, { actor: "agent", ops: [{ op: "plan_add", text: "Agent step" }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const refused = await s.send("POST", `/api/threads/${ids.harness}/board`, { actor: "agent", ops: [{ op: "todo_update", id: "t2", reply: "yes" }] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Only the owner answers a todo/);
  });

  test("duties carry the card and the judged last run, and check-ins pause", async () => {
    const duties = await s.get(`/api/threads/${ids.harness}/duties`);
    const d1 = duties.duties.find((d: any) => d.duty.id === "d1");
    assert.equal(d1.last.verdict, "missed");
    assert.equal(d1.card.streak, 2);
    const paused = await s.send("POST", `/api/threads/${ids.harness}/check-in`, { pause: "1h" });
    assert.equal(paused.body.paused, true);
    const rows = await s.get("/api/boards");
    assert.equal(rows.find((r: any) => r.chatId === ids.harness).checkIn.paused, true);
  });
});

describe("agents, usage and hosts", () => {
  test("create, rename, change model and archive a thread", async () => {
    const created = await s.send("POST", "/api/agents", { name: "spec thread", model: "anthropic/claude-sonnet-5-5", thinkingLevel: "medium" });
    assert.equal(created.body.model.id, "claude-sonnet-5-5");
    const id = created.body.id;
    const renamed = await s.send("PATCH", `/api/c/${id}`, { name: "spec thread 2", model: "anthropic/claude-opus-5-5" });
    assert.equal(renamed.body.summary.name, "spec thread 2");
    assert.equal(renamed.body.model.label, "Opus 5.5");
    await s.send("PATCH", `/api/c/${id}`, { archived: true });
    assert.ok(!(await s.get<Sidebar>("/api/sidebar")).solo.some(c => c.id === id));
  });

  test("usage sums by thread and model and splits cost by kind", async () => {
    const report = await s.get("/api/usage?days=7");
    assert.ok(report.rows.length > 0);
    for (const row of report.rows) {
      const parts = row.cost.input + row.cost.output + row.cost.cacheRead + row.cost.cacheWrite;
      assert.ok(Math.abs(parts - row.cost.total) < 1e-9);
    }
    assert.equal(report.days.length, 7);
    const pool = await s.get("/api/pool");
    assert.equal(pool.providers.length, 2);
  });
});
