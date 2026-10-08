import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { startChatServer } from "../src/chat-server.ts";
import { parseDutyInput, type DutyView } from "../src/shared/chat-duties.ts";

test("api/threads/:id/duties: GET lists a chat's duties; POST runs, pauses and resumes one with the write token; non-chats 404, bad input 400", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-route-"));
  const store = new DutyStore(dir);
  const now = new Date(2026, 9, 8, 18, 0).getTime();
  const command = ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { stalls_2h: 0 } }))`];
  await store.update("chat1", duties => { duties.push(parseDutyInput({ name: "Chat health", ownerWords: "w", goal: "g", onMiss: "m",
    metrics: [{ key: "stalls_2h", label: "Stalls", op: "<=", target: 0 }], schedule: { kind: "daily", at: "23:07" }, precheck: { command, cwd: dir } }, "d1", now)); });
  const duties = new Duties(store, { isChat: async id => id === "chat1", notify: async () => {}, now: () => now, tickMs: 0 });
  const backend = { duties, chats: { ids: async () => new Set(["chat1"]) }, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  type Body = { duties: DutyView[]; error?: string };
  const get = async (id: string) => { const res = await fetch(server.url + `api/threads/${id}/duties`); return { status: res.status, body: await res.json() as Body }; };
  const post = async (id: string, body: unknown, token = "token") => {
    const res = await fetch(server.url + `api/threads/${id}/duties`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Chat-Token": token, Origin: origin } });
    return { status: res.status, body: await res.json() as Body };
  };
  try {
    const listed = await get("chat1");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.duties.map(view => [view.duty.id, view.nextAt, view.running, view.runs.length]), [["d1", new Date(2026, 9, 8, 23, 7).getTime(), false, 0]]);
    assert.equal((await get("plain")).status, 404);
    assert.equal((await post("chat1", { duty: "d1", action: "pause" }, "wrong")).status, 403);
    assert.equal((await post("chat1", { duty: "d1", action: "explode" })).status, 400);
    assert.equal((await post("chat1", { duty: "d9", action: "pause" })).status, 404);
    assert.equal((await post("plain", { duty: "d1", action: "pause" })).status, 404);
    const paused = await post("chat1", { duty: "d1", action: "pause" });
    assert.deepEqual([paused.status, paused.body.duties[0]!.duty.status, paused.body.duties[0]!.nextAt], [200, "paused", null]);
    assert.equal((await post("chat1", { duty: "d1", action: "resume" })).body.duties[0]!.duty.status, "active");
    const ran = await post("chat1", { duty: "d1", action: "run" });
    assert.equal(ran.body.duties[0]!.running, true);
    await duties.settled();
    const after = (await get("chat1")).body.duties[0]!;
    assert.deepEqual([after.running, after.runs[0]?.verdict, after.runs[0]?.trigger], [false, "met", "owner"]);
  } finally { await server.close(); }
});
