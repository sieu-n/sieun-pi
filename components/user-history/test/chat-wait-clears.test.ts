// 10-19 before 05:40Z: a chat's screen kept "Waiting for a Claude account until 06:00" while the chat worked again with Prime's queue empty.
// The revive set the wait for an owner turn that failed on a pool slot, and once a turn ran with no retry it returned before it cleared it.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ModelInfo } from "../src/shared/types.ts";
import { fakeThreads, ownerAsks, reply, row, source } from "./chats-helpers.ts";

const CHAT = "01a152c0-0000-7000-8000-000000000001";
const at = (clock: string): number => Date.parse(`2026-10-19T${clock}Z`);
const SLOT = at("06:00:00");
const HELD = `Failed to resolve API key for provider "anthropic" from shell command: pi-pool-token pi-pool: this session waits for its slot at ${new Date(SLOT).toISOString()}.`;

test("the account wait clears once the chat runs a turn with no retry, and a pool wait inside the running turn still shows", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-wait-clears-"));
  const threads = fakeThreads([]);
  threads.transcripts.set(CHAT, [ownerAsks("how is the pool", at("05:20:00")), reply("error", at("05:21:00"), HELD)]);
  const hub = (retryAttempt: number) => threads.extras.set(CHAT, { info: { model: { provider: "anthropic", id: "claude-opus-5-5" } as ModelInfo, retryAttempt, queuedActions: 0 },
    queue: { steering: [], followUp: [] }, retry: retryAttempt ? { error: HELD } : null } as never);
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = at("05:30:00");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
    { ...source(home, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), home });
  const wake = async (clock: string) => {
    now = at(clock);
    await chats.tick();
    await chats.settled();
    await new Promise(resolve => setTimeout(resolve, 20));
    return threads.waits.get(CHAT);
  };

  hub(0);
  assert.deepEqual(await wake("05:30:00"), { kind: "account", until: SLOT }, "the failed owner turn waits for its pool slot");
  threads.busyIds.add(CHAT);
  assert.equal(await wake("05:40:00"), null, "a turn runs with no retry, so the wait line goes");
  hub(1);
  assert.deepEqual(await wake("05:45:00"), { kind: "account", until: SLOT }, "Prime sleeps on the pool slot inside the running turn");
  chats.close();
});
