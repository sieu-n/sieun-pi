/**
 * One real turn end to end on pi-host: create a thread, send, see the streamed answer, Stop, spawn a job and see it in the tree, mention
 * the thread from a channel and see the answer come back. It runs on the live pi-host socket and real model calls.
 * Run: cd apps/chat && APPS_CHAT_REAL=1 node --import tsx --test --test-force-exit --test-isolation=none test/server/pi-host.test.ts
 * Add APPS_CHAT_URL=http://127.0.0.1:5184 to run the same steps against the installed service instead of a server in this process.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, LiveEvent, TimelinePage } from "../../web/src/lib/api/types.ts";
import { start, until, type LiveClient, type Running } from "./helpers.ts";

const real = process.env.APPS_CHAT_REAL === "1";
type Turn = Extract<Item, { kind: "turn" }>;
const turns = (page: TimelinePage) => page.items.filter((i): i is Turn => i.kind === "turn");

describe("pi-host end to end", { skip: !real && "set APPS_CHAT_REAL=1 to run on the live pi-host" }, () => {
  let s: Running;
  let live: LiveClient;
  let thread: string;
  /** Every channel the spec makes, archived in `after` whether its test passed or not, so the owner's sidebar stays clean. */
  const channels: string[] = [];

  before(async () => {
    s = await start({ real: true, ...(process.env.APPS_CHAT_URL ? { url: process.env.APPS_CHAT_URL } : {}) });
    live = await s.live();
    const created = await s.send("POST", "/api/agents", { name: `apps-chat e2e ${new Date().toISOString().slice(0, 16)}` });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    thread = created.body.id;
    live.watch(thread);
  });

  after(async () => {
    if (thread) await s.send("PATCH", `/api/c/${thread}`, { archived: true });
    for (const id of channels) await s.send("PATCH", `/api/channels/${id}`, { archived: true });
    await s.close();
  });

  test("a send streams the answer into the timeline", { timeout: 180_000 }, async () => {
    const sent = await s.send("POST", `/api/c/${thread}/send`, { text: "Reply with exactly the word pong and nothing else.", requestId: `e2e-pong-${thread}` });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await live.waitFor(e => e.type === "status" && e.conversation === thread && e.status === "working", 60_000);
    const done = await live.waitFor((e: LiveEvent) => e.type === "items" && e.conversation === thread && e.items.some(i => i.kind === "turn" && /pong/i.test(i.text)), 150_000);
    assert.equal(done.type, "items");
    await live.waitFor(e => e.type === "status" && e.conversation === thread && e.status === "idle", 60_000);
    const page = await s.get<TimelinePage>(`/api/c/${thread}/items`);
    assert.match(turns(page).at(-1)!.text, /pong/i);
  });

  test("Stop ends a running turn", { timeout: 240_000 }, async () => {
    const before = live.events.length;
    await s.send("POST", `/api/c/${thread}/send`, { text: "Write the numbers from 1 to 3000, one per line, with no other text.", requestId: `e2e-stop-${thread}` });
    await live.waitFor(e => live.events.indexOf(e) >= before && e.type === "status" && e.conversation === thread && e.status === "working", 60_000);
    await live.waitFor(e => live.events.indexOf(e) >= before && e.type === "partial" && e.conversation === thread && (e.partial?.text.length ?? 0) > 20, 150_000);
    const stopped = await s.send("POST", `/api/c/${thread}/abort`);
    assert.equal(stopped.status, 200);
    await live.waitFor(e => live.events.indexOf(e) >= before && e.type === "status" && e.conversation === thread && e.status === "idle", 60_000);
    const page = await until(() => s.get<TimelinePage>(`/api/c/${thread}/items`), p => turns(p).at(-1)?.live === false, 30_000);
    const last = turns(page).at(-1)!;
    assert.ok(last.stop === "aborted" || !/3000\s*$/.test(last.text), `the turn ran to the end: ${last.text.slice(-80)}`);
  });

  test("a spawned job shows in the tree and as a pill", { timeout: 900_000 }, async () => {
    await s.send("POST", `/api/c/${thread}/send`, {
      text: "Call the subagent tool once with the task: Reply with the single word kiwi. Then reply with exactly what the subagent answered.",
      requestId: `e2e-spawn-${thread}`,
    });
    // The job's own model calls wait their place in pi-pool's turn queue like any agent's, so this allows for a full queue.
    const jobs = await live.waitFor(e => e.type === "jobs" && e.thread === thread && e.jobs.length > 1, 600_000);
    assert.equal(jobs.type === "jobs" && jobs.jobs[1]!.parent, thread);
    const page = await until(() => s.get<TimelinePage>(`/api/c/${thread}/items`), p => turns(p).some(t => t.jobs.length > 0 && !t.live), 800_000);
    const pill = turns(page).find(t => t.jobs.length > 0)!;
    assert.match(pill.jobs[0]!.conversation, new RegExp(`^${thread}:\\d+$`));
    const job = await s.get<TimelinePage>(`/api/c/${encodeURIComponent(pill.jobs[0]!.conversation)}/items`);
    assert.match(turns(job).at(-1)!.text, /kiwi/i);
    const agents = await s.get<any[]>("/api/agents");
    assert.ok(agents.some(a => a.id === pill.jobs[0]!.conversation && a.parent?.id === thread));
  });

  test("a channel mention reaches the thread and the answer comes back", { timeout: 300_000 }, async () => {
    const channel = await s.send("POST", "/api/channels", { name: `e2e-${Date.now().toString(36)}`, members: [thread] });
    assert.equal(channel.status, 200, JSON.stringify(channel.body));
    channels.push(channel.body.id);
    const name = (await s.get(`/api/c/${thread}`)).summary.name;
    const posted = await s.send("POST", `/api/c/${channel.body.id}/send`, { text: `@${name} reply with the single word mango.`, mentions: [thread], requestId: `e2e-mention-${thread}` });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.deliveries[0].state, "delivered");
    const reply = await until(() => s.get(`/api/c/${channel.body.id}/replies/${posted.body.item.id}`), r => r.items.length > 0, 240_000);
    assert.equal(reply.items[0].author.id, thread);
    assert.match(reply.items[0].text, /mango/i);
    assert.equal(reply.root.deliveries[0].state, "answered");
  });
});
