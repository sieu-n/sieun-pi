// Prime's generic park state (load.3, schema 39) on a daemon row, read before the file parse that Prime builds before load.3 still need: a
// resident row's `credentialPark` with ISO times, a saved row's taskState "waiting" verdict, and a row with neither, which reads the file.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import * as chatAgents from "../src/chat-agents.ts";
import { childActivity } from "../src/client/children.ts";
import { applyRosterUpdate, agentIdOf, rowKey } from "../src/session-peer.ts";
import type { ChatAgent, ChildAgent } from "../src/shared/types.ts";
import { parkedUntil, poolPark, primePark, readRowSlotPark, slotParkWords } from "../src/slot-park.ts";
import { agentDir, at, EMPTY, ID, LISTED, PARKED } from "./slot-park-replay.ts";

const LABEL = "a working slot, place 104 of 185";
/** A resident row of a parked session as load.3's summaryForActiveSession sends it: agent_observe's ISO times, never epoch ms. */
const resident = { sessionId: ID, activeSessionId: "a1", taskState: "waiting", summary: `Waiting for ${LABEL}`,
  credentialPark: { waitingFor: LABEL, waitingSince: "2026-10-27T21:12:20.715Z", resumeAt: "2026-10-27T21:32:21.000Z" } };
/** A saved row of the same session after the idle unload: only the verdict, which Prime sends while it is current. */
const saved = { sessionId: ID, taskState: "waiting", summary: `Waiting for ${LABEL}` };

test("a resident row's credentialPark is the wait, with its ISO times read as epoch ms", () => {
  const park = primePark(resident)!;
  assert.deepEqual(park, { label: LABEL, since: at("2026-10-27T21:12:20.715Z"), resumeAt: at("2026-10-27T21:32:21.000Z"), ended: true });
  assert.equal(slotParkWords(park), `waits for ${LABEL}`);
  assert.equal(parkedUntil({ park }, at("2026-10-27T21:14:00Z")), at("2026-10-27T21:32:21.000Z"), "the idle unload stops it until Prime's wake");
});

test("a saved row with taskState waiting is the wait, labelled from its verdict", () => {
  assert.deepEqual(primePark(saved), { label: LABEL, ended: true });
  assert.deepEqual(primePark({ taskState: "waiting", summary: "" }), { label: "a provider credential", ended: true });
});

test("a row without taskState waiting or credentialPark has no Prime park", () => {
  assert.equal(primePark({ sessionId: ID, taskState: "error", summary: "pi-pool: this run waits for a working slot" }), undefined);
  assert.equal(primePark({ sessionId: ID }), undefined);
  assert.equal(primePark(undefined), undefined);
});

test("a row with Prime's park is read without the file, and one without falls back to the file's parse", async () => {
  const missing = "/nonexistent/prime-park.jsonl";
  assert.deepEqual(await readRowSlotPark({ ...saved, sessionFile: missing }), { park: { label: LABEL, ended: true }, complete: true });
  const dir = await agentDir(PARKED);
  const file = `${dir}/sessions/${ID}.jsonl`;
  const read = await readRowSlotPark({ sessionFile: file });
  assert.deepEqual(read.park, { since: at("2026-10-27T20:55:56.986Z"), place: 104, total: 185, resumeAt: at("2026-10-27T21:32:21.000Z"), ended: true });
  assert.deepEqual(await readRowSlotPark({ sessionFile: missing }), { complete: true });
});

test("Prime's park lasts until Prime clears it, and pi-pool's live place wins over the label's", () => {
  const park = primePark(saved)!;
  assert.deepEqual(poolPark(park, ID, at("2026-10-28T03:00:00Z"), EMPTY), park, "no resumeAt, and the pool does not list it: Prime still says waiting");
  const listed = poolPark(park, ID, at("2026-10-27T21:14:00Z"), LISTED)!;
  assert.equal(slotParkWords(listed), "waits for a working slot, place 61 of 170");
  const starting = poolPark(primePark(resident)!, ID, at("2026-10-27T21:14:00Z"), { queued: new Map(), working: new Set([ID]) })!;
  assert.deepEqual(starting, { since: at("2026-10-27T21:12:20.715Z"), resumeAt: at("2026-10-27T21:32:21.000Z"), starting: true });
});

test("agents panel: a saved job Prime reports as waiting shows Prime's label", () => {
  const agent: ChatAgent = { key: `thread:${ID}`, sessionId: ID, name: "page writer", job: "page writer", sender: "page writer", link: "root", state: "failed", steps: ["p9"] };
  const [shown] = chatAgents.withSlotParks([agent], new Map([[ID, poolPark(primePark(saved), ID, at("2026-10-27T21:14:00Z"), EMPTY)!]]));
  assert.equal(shown!.state, "working");
  assert.equal(chatAgents.agentLines([shown!], at("2026-10-27T21:14:00Z"))[1], `- page writer: waits for ${LABEL} (p9)`);
});

test("a roster row without taskState clears a kept waiting verdict and credentialPark, so a resumed session is no longer parked", () => {
  const live = { ...resident, id: "a1", lifecycle: "live", activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0,
    sessionFile: `/tmp/${ID}.jsonl` } as unknown as SessionSummary;
  const agents = new Map<string, string>();
  const rows = new Map<string, SessionSummary>();
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(live), status: "running", summary: live }] });
  assert.notEqual(primePark(rows.get(rowKey(live))), undefined);
  const { taskState: _, credentialPark: __, ...ran } = live as SessionSummary & { credentialPark?: unknown };
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(live), status: "running", summary: { ...ran, summary: "Writes the page" } as SessionSummary }] });
  assert.equal(primePark(rows.get(rowKey(live))), undefined);
});

test("a subagent whose rlm snapshot waits shows what it waits for, with list_subagents's epoch-ms times left alone", () => {
  const child = (activity: ChildAgent["activity"]): ChildAgent => ({ id: "c1", label: "page writer", status: "running", ...activity ? { activity } : {} });
  const parked = { kind: "waiting" as const, waitingFor: LABEL, waitingSinceMs: at("2026-10-27T21:12:20.715Z"), resumeAtMs: at("2026-10-27T21:32:21.000Z") };
  assert.equal(childActivity(child(parked)), `Waiting for ${LABEL}`);
  assert.equal(childActivity(child({ kind: "waiting" })), "Waiting");
  assert.equal(childActivity(child({ kind: "writing" })), "Writing");
});
