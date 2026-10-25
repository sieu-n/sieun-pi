// At the release-1ca77d6 start at 11:14:42Z on 10-25 an api/threads/<id>/agents read waited 1.7 s on chats.ids() while the chat list read each of
// the 16 chats' duty runs (23 MB) for its last check-in, and d7 counted 11:14Z dirty.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const CHAT = "01a171ac-2a07-7035-9c50-2bbf4df8035c";

test("the chat ids answer before the last check-ins are read, and the check-in view still waits for them", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-ids-"));
  try {
    const index = new IdIndex(join(home, "chats.json"), "Chat index");
    await index.add(CHAT);
    let read!: (at: number) => void;
    const lastRead = new Promise<number>(resolve => { read = resolve; });
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
      { ...source(home, {}, () => Date.parse("2026-10-25T11:15:00Z")), home, duty: { async checkIn() { return "started" as const; }, lastCheckIn: () => lastRead } });
    const late = new Promise<"late">(resolve => { setTimeout(resolve, 1000, "late").unref(); });
    assert.deepEqual(await Promise.race([chats.ids().then(ids => [...ids]), late]), [CHAT]);
    let viewed = false;
    const view = chats.checkInView(CHAT).then(found => { viewed = true; return found; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(viewed, false, "the check-in view waits for the last check-in");
    read(Date.parse("2026-10-25T11:00:00Z"));
    assert.equal((await view)?.lastAt, Date.parse("2026-10-25T11:00:00Z"));
    chats.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
