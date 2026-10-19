// Guards api portal vp's d2 runs on 10-19 from 14:09Z to 14:40Z: pi-pool held the trees of parity prod promote 12, parity missing routes and
// parity crawler errors after their cuts between 13:30Z and 14:08Z, and each run recorded every fix step's job as not live ("live": false).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PoolHeldJobs } from "../src/chat-resume.ts";
import { fixLiveReader } from "../src/shared/duty-fixes.ts";
import type { PoolHeldRun } from "../src/shared/interrupted.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";

const chat = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const promote = "01a14eca-48df-7108-a4bd-c970f4a0df20", missing = "01a14eca-6940-757d-b117-e0c91cb2fa41", crawler = "01a14eca-8c5c-7589-a8a1-690ea7d8dc71";
const row = (id: string, fields: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/", kind: "session", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, ...fields } as SessionRow);
const agent = (name: string, sessionId: string): ChatAgent => ({ key: "thread:" + sessionId, name, job: name, sender: name, link: "root", state: "idle", steps: [], sessionId });
const rows = [
  row(chat, { agents: [agent("parity prod promote 12", promote), agent("parity missing routes", missing)] }),
  row(promote, { name: "parity prod promote 12", archived: true }), row(missing, { name: "parity missing routes", archived: true }),
  row(crawler, { name: "parity crawler errors", archived: true }),
];
const held = (name: string, session: string, cut: string, host?: string): PoolHeldRun => ({ id: session, name, session_id: session, head: session,
  head_session_id: session, tree: session, provider: "anthropic", errored_at: cut, held_by: "pi-pool holds the tree until 2026-10-19T14:46:00+00:00",
  pool_at: "2026-10-19T14:46:00+00:00", ...host ? { host } : {} });
const steps = [
  { id: "p29", job: "parity prod promote 12", sessionId: promote },
  { id: "p30", job: "parity missing routes", sessionId: missing },
  { id: "p32", job: "parity crawler errors", sessionId: crawler },
];

test("a fix job pi-pool holds after a cut is live, on this box or another, and a child or a sibling root", async () => {
  const jobs = new PoolHeldJobs(async () => false);
  jobs.set([held("parity prod promote 12", promote, "2026-10-19T13:47:33.595Z"), held("parity missing routes", missing, "2026-10-19T13:30:30.688Z"),
    held("parity crawler errors", crawler, "2026-10-19T14:08:12.690Z", "sieun-mac-a")]);
  const now = () => Date.parse("2026-10-19T14:40:04.984Z");
  const live = fixLiveReader({ rows: async () => rows, asleep: async () => [], pool: async () => [], held: () => jobs.sessions() }, now);
  for (const step of steps) assert.equal(await live(chat, step), true, step.job);
  const none = fixLiveReader({ rows: async () => rows, asleep: async () => [], pool: async () => [], held: () => [] }, now);
  for (const step of steps) assert.equal(await none(chat, step), false, `${step.job} waits for nothing`);
});

test("a fix job asleep on a board.wake stays live when the pi-pool read fails", async () => {
  const now = () => Date.parse("2026-10-19T15:05:00Z");
  const live = fixLiveReader({ rows: async () => rows, asleep: async () => [missing], pool: async () => { throw new Error("pool down"); }, held: () => [] }, now);
  assert.equal(await live(chat, steps[1]!), true);
  assert.equal(await live(chat, steps[0]!), false);
});

test("the held sessions outlive a restart, so the first push check after a release reads them before the first pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pool-held-"));
  try {
    const file = join(dir, "pool-held.json");
    await new PoolHeldJobs(async () => false, file).set([held("parity missing routes", missing, "2026-10-19T13:30:30.688Z")]);
    assert.deepEqual([...new PoolHeldJobs(async () => false, file).sessions()], [missing]);
    assert.deepEqual([...new PoolHeldJobs(async () => false, join(dir, "none.json")).sessions()], []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
