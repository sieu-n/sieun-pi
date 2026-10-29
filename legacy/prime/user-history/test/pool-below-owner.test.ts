// A step owner whose own turn ended while a session below it holds a pi-pool turn moves its step: at 12:04Z on 10-29 d9 counted ops guy's p613,
// whose job "staging convex io cut" waited on io-contactfind and io-brands, both queued in a full pool until 12:09:52Z and 12:10:08Z.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { poolWaitingOwners, wakingOwners } from "../scripts/duties/whole-system.ts";
import { withPoolBelow } from "../src/chat-agents.ts";
import type { ChatAgent, ChatBoard } from "../src/shared/types.ts";
import { rowOwnerReads, unmovedSteps } from "../src/unmoved-steps.ts";

const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const JOB = "01a1872c-9843-741c-bb5d-c5c97f24b350";
const KID = "01a18742-7de8-745d-89d5-49b4fd57852d";
const now = Date.parse("2026-10-29T12:04:30Z");
const ended = JSON.stringify({ type: "message", timestamp: "2026-10-29T11:05:00Z", message: { role: "assistant", stopReason: "stop", content: [] } });
const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p613", text: "Cut staging Convex IO", status: "doing", sessionId: JOB, children: [] }] };
const boards = new Map([[CHAT, board]]);
const empty = { queued: new Map(), working: new Set<string>() };

/** An agent dir laid out as Prime writes it: the job in `<chat>/sub-<job>/`, its subagent in `<chat>/sub-<job>/sub-<kid>/`. */
async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pool-below-owner-"));
  const job = join(dir, "session-artifacts", CHAT, "sub-f276551c");
  await mkdir(join(job, "sub-d4d8b912"), { recursive: true });
  await writeFile(join(job, `${JOB}.jsonl`), `${ended}\n`);
  await writeFile(join(job, "semantic-edges.jsonl"), "");
  await writeFile(join(job, "sub-d4d8b912", `${KID}.jsonl`), `${ended}\n`);
  return dir;
}

test("d9: a step owner whose subagent is queued or working in pi-pool is live, and one with no pool turn below it is not", async () => {
  const dir = await agentDir();
  const queued = { queued: new Map([[KID, { position: 3, total: 21 }]]), working: new Set<string>() };
  const working = { queued: new Map(), working: new Set([KID]) };
  assert.deepEqual([...await poolWaitingOwners(dir, boards, new Map(), async () => queued, now)], [JOB]);
  assert.deepEqual([...await poolWaitingOwners(dir, boards, new Map(), async () => working, now)], [JOB]);
  assert.deepEqual([...await poolWaitingOwners(dir, boards, new Map(), async () => empty, now)], []);
});

test("d9: a board.wake set by a job's subagent makes the job a live owner", async () => {
  const dir = await agentDir();
  const wakes = join(dir, "wakes");
  await mkdir(wakes);
  await writeFile(join(wakes, `${KID}-1.json`), JSON.stringify({ session: KID, on: { kind: "run", run: 39080016700 }, note: "", since: now - 60_000 }));
  assert.deepEqual([...await wakingOwners(dir, wakes, boards, now)], [JOB]);
});

test("the chat service reads a job whose subagent is queued for a slot as moving its step", () => {
  const agent: ChatAgent = { key: "child:f276551c", sessionId: JOB, name: "staging convex io cut", job: "staging convex io cut", sender: "staging convex io cut",
    link: "subagent", state: "idle", lastActivityAt: "2026-10-29T11:05:00Z", steps: ["p613"] };
  const below = (session: string) => session === JOB ? [KID] : [];
  const [moved] = withPoolBelow([agent], new Map([[KID, { position: 3, total: 21, since: now - 3_600_000 }]]), below);
  assert.equal(moved!.state, "working");
  assert.equal(moved!.wait, "waits on a subagent queued 3 of 21 for a working slot");
  const reads = rowOwnerReads({ id: CHAT, working: false, lastActivityAt: "2026-10-29T10:00:00Z", agents: [moved!] }, now);
  assert.deepEqual(unmovedSteps(board, now, 7_200_000, reads).map(step => step.id), []);
  const [left] = withPoolBelow([agent], new Map(), below);
  assert.deepEqual(unmovedSteps(board, now, 7_200_000, rowOwnerReads({ id: CHAT, working: false, lastActivityAt: "2026-10-29T10:00:00Z", agents: [left!] }, now)).map(step => step.id), ["p613"]);
});
