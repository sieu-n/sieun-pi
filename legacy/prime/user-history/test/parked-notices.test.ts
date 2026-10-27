// Guards 10-20 08:35Z to 10:16Z on us-metal02: Crawler VP sat parked on a 429 until 10:16:25Z, yet 27 [job] and [check-in] notices from 08:57Z to
// 09:46Z each started a turn that failed at once, so the chat never got 15 quiet minutes and its 1.05 GB worker stayed loaded (drought-resume/quiet-workers).
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "prime-agent";
import { loadRecord } from "../src/chat-brief.ts";
import { readSlotPark } from "../src/slot-park.ts";

const readQuotaPark = async (file: string, now: number): Promise<number | null> =>
  (await readSlotPark(file, now, { queued: new Map(), working: new Set() }))?.resumeAt ?? null;
import { heldNoticeRecord } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import type { ThreadHub } from "../src/chat-threads.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { IdIndex } from "../src/id-index.ts";
import { OwnerOutbox } from "../src/owner-outbox.ts";
import type { ChatBoard, ChildAgent } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const START = Date.parse("2026-10-20T08:35:23.057Z");
const RESUME = Date.parse("2026-10-20T10:16:25.096Z");
const MARKER = "<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset.\n</provider_quota_resumed>";

/** A chat's session file as Prime writes it; `parked` adds the provider_quota_park entry of Crawler VP's 08:35Z park. */
function session(dir: string, parked: boolean): { manager: SessionManager; file: string } {
  const manager = SessionManager.create(dir, dir);
  manager.appendCustomEntry("chat_mode", { v: 1 });
  manager.appendMessage({ role: "user", content: "[job] media worker cpu ended its turn", timestamp: START - 5_000 });
  if (parked) manager.appendCustomEntry("provider_quota_park", { resumeAt: new Date(RESUME).toISOString(), parkCount: 0, provider: "anthropic" });
  manager.flushNow();
  return { manager, file: manager.getSessionFile()! };
}

const step = (id: string, job: string) => ({ id, text: `the ${job} work`, status: "doing" as const, job, children: [] });
const board = (...jobs: string[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-20T08:00:00Z", todos: [], plan: jobs.map((job, index) => step(`p${index + 1}`, job)) });
const job = (id: string, name: string, working: boolean): ChildAgent =>
  ({ id, label: name, sessionName: name, status: working ? "running" : "error", ...working ? { activity: { kind: "writing" as const } } : {}, lastActivityAt: START });

test("notices to a parked chat start no turn and go once, in order, at its resume; the owner's message and a chat that is not parked go at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parked-notices-"));
  const parked = session(dir, true), awake = session(dir, false);
  const files: Record<string, string> = { c1: parked.file, c2: awake.file };
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const hub = { ...threads,
    async prompt(id: string, input: { message: string; mode: string; owner?: boolean }) { calls.push(`${input.owner ? "owner " : ""}${input.mode} ${id} ${input.message.split(",")[0]}`); },
    archivedSince: () => false, copyOf: async () => "unknown", setOutbox: () => {} };
  let clock = START + 20 * 60_000;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  await index.add("c2");
  const heldFile = join(dir, "held-notices.json");
  const chats = new Chats(index, hub, async id => ({ lifecycle: "live", ...files[id] ? { sessionFile: files[id] } : {} }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board("census seed order", "snapshot tables"), c2: board("crawl cpu") }, () => clock), heldNotices: heldNoticeRecord(heldFile) });
  // The chats paused their own check-ins, so a tick runs only the revive, the job pass and the held notices.
  const settings = source(dir).settings;
  for (const id of ["c1", "c2"]) await settings.update(id, setting => ({ ...setting, pausedUntil: "forever", pausedBy: "agent" }));
  await chats.adopt();
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await chats.settled(); };

  threads.fire().live("c1", [job("k1", "census seed order", true), job("k2", "snapshot tables", true)]);
  threads.fire().live("c2", [job("k3", "crawl cpu", true)]);
  await flush();
  calls.length = 0;
  threads.fire().children("c1", [job("k1", "census seed order", false), job("k2", "snapshot tables", true)]);
  threads.fire().children("c2", [job("k3", "crawl cpu", false)]);
  await flush();
  threads.fire().children("c1", [job("k1", "census seed order", false), job("k2", "snapshot tables", false)]);
  await flush();
  assert.deepEqual(calls, ["steer c2 [job] crawl cpu failed"], "a chat that is not parked gets its notice at once, as before; the parked chat gets no steer, so no turn");
  assert.deepEqual(JSON.parse(await readFile(heldFile, "utf8")).c1.map((line: string) => line.split(",")[0]), ["[job] census seed order failed", "[job] snapshot tables failed"],
    "both notices wait on disk, in the order they came");

  calls.length = 0;
  const outbox = new OwnerOutbox(join(dir, "outbox"), { threads: hub as unknown as ThreadHub, chats, catalog: { notify: async () => {} } as unknown as Catalog }, () => {},
    { sleep: () => new Promise(resolve => setTimeout(resolve, 5)) });
  await outbox.submit({ id: "owner-1", threadId: "c1", text: "what is stuck?", images: [], mode: "steer", fingerprint: "f1" });
  await outbox.outbox.idle();
  await outbox.close();
  assert.deepEqual(calls, ["owner steer c1 what is stuck?"], "the owner's message to the parked chat still goes at once as an owner turn");

  calls.length = 0;
  clock = RESUME - 60_000;
  await chats.tick();
  await flush();
  assert.deepEqual(calls, [], "the tick sends nothing while the park lasts");

  clock = RESUME + 30_000;
  parked.manager.appendMessage({ role: "user", content: MARKER, timestamp: RESUME + 1_000 });
  parked.manager.flushNow();
  await chats.tick();
  await flush();
  assert.deepEqual(calls, ["steer c1 [job] census seed order failed", "steer c1 [job] snapshot tables failed"], "the resume gets the held notices once, oldest first");
  calls.length = 0;
  await chats.tick();
  await flush();
  assert.deepEqual(calls, [], "each held notice went once");
  assert.deepEqual(JSON.parse(await readFile(heldFile, "utf8")), {});
  chats.close();
});

test("a chat reads parked from Prime's provider_quota_park until its resumeAt or a provider_quota_resume, as Crawler VP's 10-20 parks ran", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parked-notices-"));
  const { manager, file } = session(dir, true);
  assert.equal(await readQuotaPark(file, START + 60_000), RESUME, "parked at 08:36Z until 10:16:25Z");
  assert.equal(await readQuotaPark(file, RESUME + 1_000), null, "the park ends at its resumeAt");
  const again = Date.parse("2026-10-20T10:46:38.088Z");
  manager.appendMessage({ role: "user", content: MARKER, timestamp: RESUME + 1_000 });
  manager.appendCustomEntry("provider_quota_park", { resumeAt: new Date(again).toISOString(), parkCount: 0, provider: "anthropic" });
  manager.flushNow();
  assert.equal(await readQuotaPark(file, RESUME + 60_000), again, "the resume's own 429 parked it again, until 10:46:38Z");
  manager.appendCustomEntry("provider_quota_resume", { outcome: "early" });
  manager.flushNow();
  assert.equal(await readQuotaPark(file, RESUME + 24 * 60_000), null, "the early resume at 10:40:37Z ends the park before its resumeAt");
  assert.equal(await readQuotaPark(join(dir, "missing.jsonl"), START), null, "a file that cannot be read is not parked");
});
