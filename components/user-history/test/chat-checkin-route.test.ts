import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { CHECK_IN_MS, checkInSettings } from "../src/checkin-settings.ts";
import { startChatServer } from "../src/chat-server.ts";
import { Chats } from "../src/chats.ts";
import { type ChatThreads } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { IdIndex } from "../src/id-index.ts";
import type { CheckInView } from "../src/shared/types.ts";

test("api/threads/:id/check-in: GET reads a chat's setting, POST sets the interval or a pause with the write token, as the owner only from the owner's page; non-chats 404, bad input 400", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-in-route-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("chat1");
  const now = new Date(2026, 9, 8, 14, 0).getTime();
  const threads = { observe: () => () => {} } as unknown as ChatThreads;
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { board: async () => null, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")), settings: checkInSettings(join(dir, "check-in-settings.json")),
      tickMs: 0, now: () => now });
  let notified = 0;
  const backend = { chats, catalog: { notify: async () => { notified++; } }, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const get = async (id: string) => { const res = await fetch(server.url + `api/threads/${id}/check-in`); return { status: res.status, body: await res.json() as CheckInView }; };
  const post = async (id: string, body: unknown, token = "token", headers: Record<string, string> = {}) => {
    const res = await fetch(server.url + `api/threads/${id}/check-in`, { method: "POST", body: JSON.stringify(body),
      headers: { ...headers, "Content-Type": "application/json", "X-Chat-Token": token, Origin: origin } });
    return { status: res.status, body: await res.json() as CheckInView & { error?: string } };
  };
  const stored = () => checkInSettings(join(dir, "check-in-settings.json")).get("chat1");
  try {
    assert.deepEqual(await get("chat1"), { status: 200, body: { everyMs: CHECK_IN_MS, paused: false, nextAt: now, pausedUntil: null, lastAt: null } });
    assert.equal((await get("plain")).status, 404);
    const set = await post("chat1", { everyMs: 15 * 60_000 }, "token", { "X-Chat-Owner-Ui": "1" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.everyMs, 900_000);
    assert.equal(notified, 1, "the sessions stream gets the new row");
    const paused = await post("chat1", { pause: "tomorrow" });
    assert.deepEqual([paused.body.paused, paused.body.pausedUntil, paused.body.everyMs], [true, new Date(2026, 9, 9, 9, 0).getTime(), 900_000]);
    assert.equal((await post("chat1", { pause: "forever" })).body.nextAt, null);
    assert.deepEqual((await get("chat1")).body.pausedUntil, "forever");
    const resumed = await post("chat1", { pause: null, everyMs: 60_000 }, "token", { "X-Chat-Owner-Ui": "1" });
    assert.deepEqual([resumed.body.paused, resumed.body.everyMs], [false, 60_000]);
    assert.equal((await post("chat1", { everyMs: 60_000 }, "wrong")).status, 403, "the write token is required");
    assert.equal((await post("plain", { everyMs: 60_000 })).status, 404);
    for (const body of [{}, { everyMs: 30_000 }, { everyMs: 241 * 60_000 }, { everyMs: "5" }, { pause: "2h" }]) assert.equal((await post("chat1", body)).status, 400, JSON.stringify(body));
    assert.deepEqual(await stored(), { everyMs: 60_000 }, "refused input changes nothing");

    await post("chat1", { pause: "forever" }, "token", { "X-Chat-Agent-Session": "01a00000-0000-7000-8000-000000000008" });
    assert.deepEqual(await stored(), { everyMs: 60_000, pausedUntil: "forever", pausedBy: "agent", setter: "01a00000-0000-7000-8000-000000000008" }, "an agent that names itself");
    await post("chat1", { pause: "forever" });
    assert.deepEqual(await stored(), { everyMs: 60_000, pausedUntil: "forever", pausedBy: "agent", setter: "unknown" }, "the token alone is an agent's call");
    await post("chat1", { pause: "forever" }, "token", { "X-Chat-Owner-Ui": "1" });
    assert.deepEqual(await stored(), { everyMs: 60_000, pausedUntil: "forever", pausedBy: "owner", setter: "ui" }, "the owner's page");
    const refused = await post("chat1", { pause: null }, "token", { "X-Chat-Owner-Ui": "1", "X-Chat-Agent-Session": "s2" });
    assert.deepEqual([refused.status, refused.body.error], [409, "check-in refused: the owner paused check-ins until they resume them; that stays"],
      "an agent that names itself is an agent, whatever else it sends");
    assert.equal((await post("chat1", { pause: null }, "token", { "X-Chat-Owner-Ui": "1" })).body.paused, false, "the owner resumes");
  } finally { await server.close(); chats.close(); }
});
