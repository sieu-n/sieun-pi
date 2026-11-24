// Replays 11-23 22:46:32Z on Crawler VP (01a115e2). A hand-over removed the chat's old plan steps with plan_remove, and a plan_set put them back
// with their ids, so about 100 done fix steps read as closed (`closedFixes`). The duty runner then started verify runs of 8 duties, among them
// the paused d1, d2, d9 and d10, and their 4 jobs worked until 05:01Z on 11-24. Agent factory removed the duties with scripts/duties/remove.ts,
// since the server's duties route had no remove.
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import { closedFixes } from "../src/shared/duty-fixes.ts";
import type { ChatBoard, CheckInView, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const NOW = Date.parse("2026-11-23T22:46:32Z");
const MIN = 60_000;

const step = (id: string, status: PlanItem["status"], duty: string): PlanItem => ({ id, text: `Fix ${id}`, status, duty, children: [] });
const board = (rev: number, top: number, plan: PlanItem[]): ChatBoard => ({ v: 2, rev, plan, todos: [], updatedAt: new Date(NOW).toISOString(), lastIds: { p: top, t: 0 } });

async function rig(t: { after: (fn: () => Promise<void>) => void }, status: Duty["status"], checkIn: Partial<CheckInView> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "verify-skips-paused-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { crawler_panels_blank: 2 } }));`);
  const store = new DutyStore(dir);
  const duty: Duty = { id: "d9", name: "Throughput goal achieved", ownerWords: "throughput", goal: "every throughput goal met",
    metrics: [{ key: "crawler_panels_blank", label: "Blank panels", op: "<=", target: 0, headline: true }], schedule: { kind: "every", minutes: 120 },
    precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status, createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000,
    runCount: 1, lastRunAt: NOW - 30 * MIN };
  await store.update(CHAT, duties => { duties.push(duty); });
  const checkIns: string[] = [];
  const lines: string[] = [];
  const duties = new Duties(store, {
    isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath, log: line => lines.push(line),
    jobs: { chat: async id => ({ id, name: "Crawler VP", cwd: dir, board: id }), working: async () => false, retire: async () => {},
      start: async (_chat, name) => ({ id: "verify-job", name }) },
    checkIn: { view: async () => ({ everyMs: 30 * MIN, paused: false, pausedUntil: null, nextAt: null, lastAt: null, ...checkIn }), set: async () => null,
      run: async (_chat, trigger) => { checkIns.push(trigger ?? "schedule"); } },
    board: async () => null, fixLive: async () => false,
  });
  t.after(async () => duties.close());
  const close = async (link: string) => {
    await duties.boardChanged(CHAT, board(1, 845, [step("p845", "doing", link)]));
    await duties.boardChanged(CHAT, board(2, 845, [step("p845", "done", link)]));
    await duties.settled();
  };
  return { store, duties, checkIns, lines, close };
}

test("a fix step that closes starts no verify run of a paused duty, and one of an active duty (Crawler VP d9, 11-23 22:46Z)", async t => {
  const paused = await rig(t, "paused");
  await paused.close("d9/crawler_panels_blank");
  assert.deepEqual(await paused.store.runs(CHAT), []);
  assert.ok(paused.lines.includes("duty 01a115e2/d9: fix p845 closed; the duty is paused or gone, so no verify run starts"));
  const active = await rig(t, "active");
  await active.close("d9/crawler_panels_blank");
  assert.deepEqual((await active.store.runs(CHAT)).map(run => [run.duty, run.trigger]), [["d9", "verify"]]);
});

test("a check-in fix step that closes starts no check-in verify while the check-in is paused (Crawler VP, 11-23 22:46Z)", async t => {
  const paused = await rig(t, "active", { paused: true, pausedUntil: "forever" });
  await paused.close("checkin/stuck_steps");
  assert.deepEqual(paused.checkIns, []);
  const running = await rig(t, "active");
  await running.close("checkin/stuck_steps");
  assert.deepEqual(running.checkIns, ["verify"]);
});

test("steps removed and put back by a plan_set do not read as closed, and a new done step still does (Crawler VP, 11-23 22:46Z)", async t => {
  const link = "d9/crawler_panels_blank";
  const full = board(10, 1274, [step("p845", "done", link), step("p1269", "done", link)]);
  const removed = board(11, 1274, []);
  const restored = board(12, 1274, [step("p845", "done", link), step("p1269", "done", link)]);
  assert.deepEqual(closedFixes(removed, restored), []);
  assert.deepEqual(closedFixes(removed, board(12, 1275, [step("p1275", "done", link)])).map(fix => fix.step), ["p1275"]);
  assert.deepEqual(closedFixes(board(10, 1274, [step("p845", "doing", link)]), restored).map(fix => fix.step), ["p845"], "an open step that closes still counts");
  const { store, duties, lines } = await rig(t, "active");
  for (const next of [full, removed, restored]) await duties.boardChanged(CHAT, next);
  await duties.settled();
  assert.deepEqual(await store.runs(CHAT), []);
  assert.deepEqual(lines.filter(line => line.includes("closed")), []);
});

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", agent: false,
      headers: { host: `127.0.0.1:${port}`, origin, "content-type": "application/json", "x-chat-token": "token" } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

test("the duties route removes a standing duty as scripts/duties/remove.ts does, and refuses to remove the check-in", async t => {
  const { store, duties } = await rig(t, "paused");
  const asset = { body: Buffer.from(""), etag: "e", contentType: "text/plain" };
  const backend = { close: async () => {}, duties, chats: { ids: async () => new Set([CHAT]) } } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-root.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const port = Number(new URL(server.url).port);
  const path = `/cap/api/threads/${CHAT}/duties`;
  const removed = await post(port, path, { action: "remove", duty: "d9" });
  assert.equal(removed.status, 200);
  assert.deepEqual((removed.json as { duties: { duty: { id: string } }[] }).duties.map(view => view.duty.id), ["checkin"]);
  assert.deepEqual(await store.list(CHAT), []);
  assert.equal((await post(port, path, { action: "remove", duty: "d9" })).status, 404);
  assert.equal((await post(port, path, { action: "remove", duty: "checkin" })).status, 400);
});
