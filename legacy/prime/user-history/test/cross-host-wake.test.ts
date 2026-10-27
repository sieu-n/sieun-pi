// Replays the dropped cross-host wake of 10-20 08:20:26Z (live runtime verification, R-verdict.md R1). The Mac job cs-stage (01a157d9-3208),
// in campaign shell (01a154d5) of the Mac chat mac-management (01a15427), set a board.wake for CI run 39382235504. Its parent deleted it at
// 07:51:44Z, and the Mac's 08:06:15Z full list no longer held it, so at 08:20:09Z no box listed it. The outbox sent the wake to this box's
// daemon, which knew no such session, and logged "01a157d9 is not a session the daemon has or can reopen; message m-1c171281-... dropped" at
// 08:20:32Z. A Mac job with a row fared the same: this box's copy of its file has no spawn record, so no relay went through its parent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { rowSubagent } from "../src/subagent-relay.ts";

const ROOT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const PARENT = "01a154d5-3766-74ce-8a4a-84469479eb96";
const CS_STAGE = "01a157d9-3208-732a-a35f-1353fa389f5f";
const ARTIFACTS = `/Users/sieunpark/.prime/agent/session-artifacts/${ROOT}`;
const NOW = Date.parse("2026-10-20T08:20:09.955Z");
const SET = 1792482357971;
const WAKE = "[wake] Run 39382235504 finished: failure (promote.yml on sieun/dev). https://github.com/sieu-n/auto-sns-agent/actions/runs/39382235504 " +
  "You set this wake with board.wake. Your note: cs-stage: promote 16 run finished; land.yml resumes after its read-back; check land.yml/origin/staging for a sieun/dev land";

const row = (sessionId: string, fields: Partial<SessionSummary>): SessionSummary => ({ sessionId, ...fields }) as SessionSummary;
const CS_STAGE_ROW = row(CS_STAGE, { sessionName: "cs-stage", runtimeKind: "subagent", parentSessionPath: `${ARTIFACTS}/sub-8178b875/${PARENT}.jsonl`,
  sessionFile: `/home/sieun/.cache/sieun-pi/hosts/mac${ARTIFACTS}/sub-8178b875/sub-46cac753/${CS_STAGE}.jsonl` });

/** This box and the Mac at 08:20:09Z: the Mac lists the root and the parent, and each daemon knows no session cs-stage. */
async function boxes(t: TestContext, { listed = [] as SessionSummary[], synced = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cross-host-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mac = new Map([ROOT, PARENT].map(id => [id, row(id, {})]));
  for (const listedRow of listed) mac.set(listedRow.sessionId, listedRow);
  const state = { synced, sends: [] as { session: string; host: string | null | undefined; text: string }[], lines: [] as string[] };
  const outbox = new AgentOutbox(join(dir, "agent-outbox"), {
    log: line => { state.lines.push(line); }, now: () => NOW,
    sleep: () => { state.synced = true; mac.set(CS_STAGE, CS_STAGE_ROW); return new Promise(resolve => setImmediate(resolve)); },
    hostOf: session => mac.has(session) ? "mac" : null,
    synced: () => state.synced,
    subagentOf: async session => rowSubagent(mac.get(session)),
    send: async (session, text, host) => {
      state.sends.push({ session, host, text });
      return host === "mac" && session !== CS_STAGE ? "sent" : "gone";
    },
    target: async () => ({ queued: [], busy: false, unfinished: 0 }),
    fileOf: async () => null,
    startRoot: async () => {},
  });
  t.after(() => outbox.close());
  await outbox.deliver(CS_STAGE, WAKE, ROOT, "wake", SET);
  await outbox.outbox.idle();
  return state;
}

test("a wake for a Mac job no box lists goes to the Mac's daemon, its root's box, and drops only when the Mac does not know it either", async t => {
  const { sends, lines } = await boxes(t);
  assert.deepEqual(sends.map(({ session, host }) => [session, host]), [[CS_STAGE, "mac"], [CS_STAGE, "mac"]]);
  assert.ok(lines.some(line => line.includes(`${CS_STAGE.slice(0, 8)} is not a session the daemon on mac has or can reopen`)), lines.join("\n"));
});

test("a stopped Mac job its row lists is reached through its parent on the Mac", async t => {
  const { sends, lines } = await boxes(t, { listed: [CS_STAGE_ROW] });
  const relay = sends.find(({ session }) => session === PARENT);
  assert.equal(relay?.host, "mac");
  assert.match(relay!.text, /^\[relay\] Your subagent "cs-stage" \(01a157d9-3208-732a-a35f-1353fa389f5f\) is stopped/);
  assert.ok(relay!.text.endsWith(WAKE));
  assert.ok(!lines.some(line => line.includes("dropped")), lines.join("\n"));
});

test("while the Mac has not listed its sessions in this run, the wake waits, and goes through the parent once the list holds the job", async t => {
  const { sends, lines } = await boxes(t, { synced: false });
  assert.ok(lines.some(line => line.includes("mac has not listed its sessions in this run")), lines.join("\n"));
  assert.equal(sends.find(({ session }) => session === PARENT)?.host, "mac");
  assert.ok(!lines.some(line => line.includes("dropped")), lines.join("\n"));
});
