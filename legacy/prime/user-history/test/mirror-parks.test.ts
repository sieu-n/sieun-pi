// A Mac job whose builder waits out the provider's usage reset moves its step: from 12:43Z to 14:45Z on 10-29 d9 counted designer bro's p405
// while its job "dm compose polish" waited on dm-compose, parked in provider_quota_park until 17:01Z, and both ran on the Mac.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mirroredParkOwners, type HostCopy } from "../scripts/duties/mirror-parks.ts";
import { planCounts } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const JOB = "01a18790-a8be-7255-8cd5-4e1da09b6780";
const KID = "01a18792-de73-70e8-a01e-07251d8f980b";
const now = Date.parse("2026-10-29T14:43:00Z");
const ROOT = "/Users/sieunpark/.prime/agent/session-artifacts";
const files = { [CHAT]: `/Users/sieunpark/.prime/agent/sessions/${CHAT}.jsonl`, [JOB]: `${ROOT}/${CHAT}/sub-40f59b07/${JOB}.jsonl`,
  [KID]: `${ROOT}/${CHAT}/sub-40f59b07/sub-bfeb31e7/${KID}.jsonl` };
const turn = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", stopReason: "stop", content: [] } });
const park = (resumeAt: string) => JSON.stringify({ type: "custom", customType: "provider_quota_park", timestamp: "2026-10-29T12:42:38.394Z", data: { resumeAt } });
const resume = JSON.stringify({ type: "custom", customType: "provider_quota_resume", timestamp: "2026-10-29T14:43:10Z", data: { outcome: "resumed" } });
const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p405", text: "Polish the DM compose screen", status: "doing", sessionId: JOB, children: [] }] };
const boards = new Map([[CHAT, board]]);
const copies: HostCopy[] = [{ host: null, rows: [] }, { host: "mac", rows: [
  { sessionId: CHAT, sessionFile: files[CHAT], activity: "idle" },
  { sessionId: JOB, sessionFile: files[JOB], parentSessionId: CHAT, activity: "idle" },
  { sessionId: KID, sessionFile: files[KID], parentSessionId: JOB, activity: "idle" },
] }];

/** A HOME whose `.cache/sieun-pi/hosts/mac` holds this box's copies of the Mac chat's, job's and builder's transcripts, as the chat service mirrors them. */
async function mirrorHome(kid: readonly string[]): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mirror-parks-"));
  process.env.HOME = home;
  for (const [id, lines] of [[CHAT, [turn("2026-10-29T12:30:00Z")]], [JOB, [turn("2026-10-29T12:42:37Z")]], [KID, kid]] as const) {
    const copy = join(home, ".cache/sieun-pi/hosts/mac", files[id]!);
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(copy, `${lines.join("\n")}\n`);
  }
}

const stuck = (poolWaiting: ReadonlySet<string>) => planCounts({ now, boards, poolWaiting, waking: new Set(), ownerActivity: new Map(), named: new Map(),
  chats: [{ id: CHAT, name: "designer bro", runs: [], everyMs: 3_600_000, paused: true, duties: [] }] }).stuck.flatMap(entry => entry.items);

test("d9: a Mac job whose builder is parked on the provider's usage reset owns its step", async () => {
  const home = process.env.HOME;
  try {
    await mirrorHome([turn("2026-10-29T12:42:00Z"), park("2026-10-29T17:01:00.000Z")]);
    const parked = await mirroredParkOwners(boards, new Map(), copies, now);
    assert.deepEqual([...parked], [JOB]);
    assert.deepEqual(stuck(parked), []);
    assert.deepEqual(stuck(new Set()), ["p405"]);
  } finally { process.env.HOME = home; }
});

test("d9: a Mac park whose reset passed or that Prime resumed is over", async () => {
  const home = process.env.HOME;
  try {
    await mirrorHome([park("2026-10-29T14:00:00.000Z")]);
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), copies, now)], []);
    await mirrorHome([park("2026-10-29T17:01:00.000Z"), resume]);
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), copies, now)], []);
  } finally { process.env.HOME = home; }
});

test("d9: Prime's park on a Mac row owns the step with no copy of the transcript", async () => {
  const home = process.env.HOME;
  try {
    process.env.HOME = await mkdtemp(join(tmpdir(), "mirror-parks-"));
    const waiting = copies.map(copy => ({ ...copy, rows: copy.rows.map(row => row.sessionId === KID
      ? { ...row, taskState: "waiting", summary: "Waiting for its pi-pool slot at 17:01:00Z" } : row) }));
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), waiting, now)], [JOB]);
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), copies, now)], []);
  } finally { process.env.HOME = home; }
});

test("d9: a Mac builder with no copy here, or a copy older than its row, is read from the Mac's relay", async () => {
  const home = process.env.HOME;
  try {
    const asked: string[] = [];
    const parkedTail = async (host: string, path: string) => { asked.push(`${host}:${path}`); return path === files[KID] ? [turn("2026-10-29T12:42:00Z"), park("2026-10-29T17:01:00.000Z")] : [turn("2026-10-29T12:42:37Z")]; };
    process.env.HOME = await mkdtemp(join(tmpdir(), "mirror-parks-"));
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), copies, now, parkedTail)], [JOB]);
    assert.deepEqual(asked.sort(), [`mac:${files[JOB]}`, `mac:${files[KID]}`].sort());
    await mirrorHome([turn("2026-10-29T12:42:00Z")]);
    const later = copies.map(copy => ({ ...copy, rows: copy.rows.map(row => ({ ...row, lastActivityAt: "2099-01-01T00:00:00Z" })) }));
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), later, now, parkedTail)], [JOB]);
    asked.length = 0;
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), copies, now, parkedTail)], []);
    assert.deepEqual(asked, []);
    const down = async () => { throw new Error("mac is not reachable"); };
    assert.deepEqual([...await mirroredParkOwners(boards, new Map(), later, now, down)], []);
  } finally { process.env.HOME = home; }
});
