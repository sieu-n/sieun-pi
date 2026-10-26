// p342: an alert triage job asked for its first turn at 21:02:02Z on 10-26 behind 73 queued runs and got it 659 s later, at 21:13:01Z
// (pi-pool.log). The chat service now puts each live triage job on the turn queue's lead list, so its run takes the next free slot and
// still waits for one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { leadList } from "../src/chat-pool-priority.ts";

const PI_POOL = fileURLToPath(new URL("../../pi-pool", import.meta.url));
const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const TRIAGE = "01a17a05-1b7d-74cb-ae99-e9a7d02e878a";
const rows = [
  { sessionId: TRIAGE, sessionName: "alert triage CI and RepoOps 06:01", lifecycle: "live", isSessionActive: true },
  { sessionId: "01a16000-0000-7000-8000-000000000001", sessionName: "alert triage ops guy 01:10", lifecycle: "archived", isSessionActive: false },
  { sessionId: "01a16000-0000-7000-8000-000000000002", sessionName: "alert triage Crawler VP 14:32", lifecycle: "live", isSessionActive: false },
  { sessionId: "01a179eb-3069-7702-a8d9-e378c55a0c6d", sessionName: "wiki index job", lifecycle: "live", isSessionActive: true },
  { sessionId: CHAT, sessionName: "CI and RepoOps", lifecycle: "live", isSessionActive: true },
];

test("the lead list holds the chats and every alert triage job a worker runs, once each, and no archived or unloaded triage job or other job", () => {
  assert.deepEqual(leadList([CHAT], rows), [CHAT, TRIAGE]);
  assert.deepEqual(leadList([], [{ sessionId: "x", lifecycle: "live", isSessionActive: true }]), [], "a row with no name is no triage job");
});

test("pi-pool's turn queue starts the triage job's run at the next free slot, ahead of 37 job runs that asked before it, and not before", () => {
  // The 10-26 queue: 12 of 12 slots working, 37 runs of one job tree that asked from 20:54Z, then the triage job at 21:02:02Z.
  const turns = { working: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, { tree: `busy${i}`, kind: "slot", since: 0, pid: 1 }])),
    queued: { ...Object.fromEntries(Array.from({ length: 37 }, (_, i) => [`sub${i}`, { tree: "01a179eb", since: 100 + i, pid: 1 }])),
      [TRIAGE]: { tree: TRIAGE, since: 600, pid: 1 } },
    owner: {}, kept: {}, lead: leadList([CHAT], rows) };
  const script = `
import json, sys
from pool import turns
t = turns.of(json.load(sys.stdin))
full = turns.admit_pass(t, 610, 12, 60, 1800)
del t["working"]["w0"]
print(json.dumps({"full": full, "first": turns.order(t)[0], "freed": turns.admit_pass(t, 622, 12, 60, 1800)}))`;
  const pool = mkdtempSync(join(tmpdir(), "triage-lead-"));
  const out = execFileSync("python3", ["-B", "-c", script], { cwd: PI_POOL, input: JSON.stringify(turns), encoding: "utf8",
    env: { ...process.env, PYTHONPATH: PI_POOL, PI_POOL_DIR: pool } });
  rmSync(pool, { recursive: true });
  const got = JSON.parse(out) as { full: unknown[]; first: string; freed: [string, string][] };
  assert.deepEqual(got.full, [], "a lead run waits while every slot works");
  assert.equal(got.first, TRIAGE);
  assert.deepEqual(got.freed, [[TRIAGE, "slot"]]);
});
