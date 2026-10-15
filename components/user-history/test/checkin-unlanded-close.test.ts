import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyDutyOps } from "../scripts/board-apply.ts";
import { unlandedClose } from "../src/checkin-done.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/*
 * The AI harness developer environment VP board (chat 01a1164b) at 10-14 08:02Z, 12 ops before rev 2568, trimmed to the goals the 17:01 KST check-in closed.
 * Steps, owners and waits are the check-in's own print of the board at 08:02:58Z; the leaf notes are the ones the 15:01 check-in wrote. The
 * three land jobs are roots the 15:01 check-in started with rlm.create_session under computed names, so the job registry never listed them.
 * At 08:04:52Z the 17:01 check-in applied OPS below through board-apply.ts and the board went to rev 2568 with 0 open steps, while
 * verify-dev runs 38529531177, 38529446596 and 38529486999 were still queued.
 */
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const RULES = { job: "skill rules land", sessionId: "01a13903-e4ac-77c9-9ebc-76a8a5a5560f" };
const REWRITE = { job: "skill rewrite land", sessionId: "01a13904-5c28-743d-a0eb-fe8f9a6c971e" };
const GUARD = { job: "stale tree guard land", sessionId: "01a13904-0527-73b8-ab31-a76ac4170a70" };
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const MET: PlanItem["requirements"] = [{ text: "the owner's request", status: "met", evidence: "the design" }];
const PLAN: PlanItem[] = [
  step("p1", "The chat app feels like messaging a VP", "todo", { note: "Every step is done.", children: [step("p86", "Chat health fixes", "done")] }),
  step("p200", "llm-wiki is reliable and every page reads like a plain blog article", "todo", { requirements: MET, children: [
    step("p224", "Wiki index fix", "done"),
    step("p249", "Build: the daily wiki duty and its first skill fixes", "todo", { job: "wiki dream duty", children: [
      step("p389", "Land the new skill rules for shared git, heavy work on the Mac and CI-only traps", "doing", { ...RULES,
        waitFor: "the fresh skill rules run pushed at 07:35Z goes green; skill rules land lands it before promote 10's hold (about 10:00Z)",
        note: "Probe run 38492678547 (object b9fae2976) was cancelled by Fable's hold and never went green. The old job is gone. skill rules land " +
          "(started 15:0x KST) rebuilds the 8 remaining files on the current tip, asks for the slot, lands on green with --probed, deletes the 20 " +
          "ledger memories, and hands the sha to skill rewrite land." }),
      step("p393", "Land the Python skill's description fix, so no two skills overlap 20% or more", "doing", { ...RULES,
        waitFor: "Fable's 'released', now about 04:30Z to 05:00Z after land 34's own run (VP of CI, 12:16 KST); then skill rules landing pushes r3 and lands",
        note: "Rides skill rules land's rebuilt object with p389 (stack/python description and its skill-map row). Run 38492678547 was cancelled by Fable's hold." })] })] }),
  step("p243", "Many agents can work in the shared repo at once without breaking each other", "todo", { children: [
    step("p254", "Every agent tool works, and nothing goes outside without your ok", "todo", { job: "skills check duty", requirements: MET, children: [
      step("p402", "Agents finish GitHub sign-ins in Aside like other logins, by the owner's 10-14 choice", "doing", { ...REWRITE,
        waitFor: "batch A's fresh run pushed at 07:35Z goes green and lands with the agent-auth sign-in row",
        note: "Harness and sieun-pi parts are done. Run 38492703550 (object 186bd3b60c, agent-auth SKILL.md row) was cancelled by Fable's hold." }),
      step("p409", "Delete the search, crawler and research agent repo skills, and rewrite every agent-written skill in plain words that keep only what agents would miss", "todo", { ...REWRITE,
        waitFor: "batch A's fresh run pushed at 07:35Z goes green and lands; batch B follows skill rules land",
        note: "Part 1 landed as b2b3006885. skill rewrite land takes over from the idle skill rewrite job." })] }),
    step("p319", "Keep the shared repo's files in step with its branch, so an old copy can't undo landed work", "doing", { ...GUARD,
      waitFor: "Fable's 'released', now about 04:30Z to 05:00Z after land 34's own run (VP of CI, 12:16 KST); then stale tree sync pushes and lands",
      note: "Tree sync part is done; the guard rides p357's probe. Run 38492874109 (object 654f4d22c6) was cancelled by Fable's hold." }),
    step("p357", "Block commits that would quietly undo newer changes to the same file", "doing", { ...GUARD,
      waitFor: "the fresh guard run pushed at 07:35Z goes green; stale tree guard land lands it before promote 10's hold (about 10:00Z)",
      note: "Run 38492874109 (object 654f4d22c6, ci/stale-tree-guard-12) was cancelled by Fable's hold and never went green." }),
    step("p316", "Shared tree sync", "done")] }),
  step("p401", "Agent work runs through one queue with a limit you set in Settings, so this Mac stops running out of memory", "doing",
    { job: "01a11af8-962e-773d-a19a-ee4104011987", note: "Queue fixes are live: sieun-pi fb3c89d and pi-pool 00a7feba9b52 at 11:32 KST." }),
];
/** The 17:01 check-in's ops at 08:04:52Z, as it built them (its scratch note dropped, as in its second call). */
const OPS = [{"op": "plan_update", "id": "p389", "status": "done", "waitFor": null, "note": "Closed here at 08:04Z and handed to the skill rules land thread, which owns the land to the end and reports to this chat. Its verify-dev run 38529531177 was still queued at 08:01Z."}, {"op": "plan_update", "id": "p393", "status": "done", "waitFor": null, "note": "Closed here at 08:04Z and handed to the skill rules land thread, which owns the land to the end and reports to this chat. Its verify-dev run 38529531177 was still queued at 08:01Z. It rides the same object as p389."}, {"op": "plan_update", "id": "p402", "status": "done", "waitFor": null, "note": "The harness and sieun-pi parts are done (global prompt v4, two memories, f3c85a4). Closed here at 08:04Z and handed to the skill rewrite land thread, which owns the land to the end and reports to this chat. Its verify-dev run 38529446596 was still queued at 08:01Z."}, {"op": "plan_update", "id": "p409", "status": "done", "waitFor": null, "note": "Part 1 landed as b2b3006885. Closed here at 08:04Z and handed to the skill rewrite land thread, which owns the land to the end and reports to this chat. Its verify-dev run 38529446596 was still queued at 08:01Z. Batch B also stays with that thread."}, {"op": "plan_update", "id": "p319", "status": "done", "waitFor": null, "note": "Tree sync part is done. Closed here at 08:04Z and handed to the stale tree guard land thread, which owns the land to the end and reports to this chat. Its verify-dev run 38529486999 was still queued at 08:01Z."}, {"op": "plan_update", "id": "p357", "status": "done", "waitFor": null, "note": "Closed here at 08:04Z and handed to the stale tree guard land thread, which owns the land to the end and reports to this chat. Its verify-dev run 38529486999 was still queued at 08:01Z."}, {"op": "plan_update", "id": "p249", "status": "done", "note": "The wiki dream duty runs daily and covers the ongoing skill fixes; its last two lands moved to the skill rules land thread at 08:04Z."}, {"op": "plan_update", "id": "p254", "status": "done", "note": "The skills check duty covers this daily (29 of 30 pass on 10-14, s207); the rewrite land moved to the skill rewrite land thread at 08:04Z."}, {"op": "plan_update", "id": "p200", "status": "done", "note": "Every step is closed: the daily Wiki dream duty holds the cleanup and mistake fixes, and the skill rules land thread owns the last land. Requirement 4 stays a known gap: no check can prove a subagent wrote a page."}, {"op": "plan_update", "id": "p243", "status": "done", "note": "Every step is closed: the skill rewrite land and stale tree guard land threads own the last three lands and report here, and the skills check duty covers tool health."}, {"op": "plan_update", "id": "p401", "status": "done", "note": "Every step is done and the queue fixes are live (pool 1c4a02e7090a at 12:37:59 KST). The ops guy (+observability) thread owns the 24 h readout at 10-14 23:16Z, sent at 08:04Z."}, {"op": "plan_update", "id": "p1", "status": "done", "note": "Every step is done: p86's health fixes are live in release-f237210 and p215 runs as the Skills and harness duty. New chat app work opens as a new goal."}];

async function board(plan: PlanItem[] = PLAN): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "unlanded-close-"));
  await mkdir(join(dataDir, "boards"));
  const value: ChatBoard = { v: 2, rev: 2556, plan, todos: [], updatedAt: "2026-10-14T08:02:43.000Z" };
  await writeFile(join(dataDir, "boards", CHAT + ".json"), JSON.stringify(value));
  return dataDir;
}
const read = async (dataDir: string): Promise<ChatBoard> => JSON.parse(await readFile(join(dataDir, "boards", CHAT + ".json"), "utf8")) as ChatBoard;
const find = (items: readonly PlanItem[], id: string): PlanItem | undefined => {
  for (const item of items) { const found = item.id === id ? item : find(item.children, id); if (found) return found; }
  return undefined;
};

test("the 17:01 check-in's closes at rev 2568 are refused: a land job's step stays open while its verify-dev run is queued (AI harness 10-14)", async () => {
  const dataDir = await board();
  await assert.rejects(applyDutyOps(dataDir, CHAT, OPS), (error: Error) => {
    for (const id of ["p389", "p393", "p402", "p409", "p319", "p357"]) assert.match(error.message, new RegExp(`\\b${id} "`), `${id} is named`);
    assert.match(error.message, /its note says "Its verify-dev run 38529531177 was still queued at 08:01Z\."/);
    assert.match(error.message, /^Nothing was applied\. A check-in does not mark a step done before its work has landed/);
    assert.doesNotMatch(error.message, /\bp401 "|\bp1 "/, "a step whose note names no unfinished run, land or push still closes");
    return true;
  });
  const after = await read(dataDir);
  assert.equal(after.rev, 2556, "all or none: the board is untouched");
  assert.equal(find(after.plan, "p389")?.status, "doing");
  assert.equal(find(after.plan, "p389")?.waitFor, "the fresh skill rules run pushed at 07:35Z goes green; skill rules land lands it before promote 10's hold (about 10:00Z)");
});

test("the same close on a cleared wait is refused when the note only hands the land to the step's job", async () => {
  const dataDir = await board();
  await assert.rejects(applyDutyOps(dataDir, CHAT, [{ op: "plan_update", id: "p357", status: "done", waitFor: null,
    note: "Closed here and handed to the stale tree guard land thread." }]), /p357 "Block commits[^"]*": it waits for "the fresh guard run pushed at 07:35Z goes green; stale tree guard land lands it before promote 10's hold \(about 10:00Z\)" and its note names no landed commit sha/);
});

test("control: a step whose note names its landed sha still closes, and so does one whose wait was on a run reported green", async () => {
  const dataDir = await board();
  const out = await applyDutyOps(dataDir, CHAT, [
    { op: "plan_update", id: "p389", status: "done", waitFor: null, note: "Landed as 032ea100bf on sieun/dev at 08:40Z after verify-dev run 38529531177 went green." },
    { op: "plan_update", id: "p357", status: "done", note: "stale tree guard land landed 1662b71ace with --probed; run 38529486999 passed." },
    { op: "plan_update", id: "p401", status: "done", note: "Every step is done and the queue fixes are live (pool 1c4a02e7090a at 12:37:59 KST)." },
  ]);
  assert.match(out, /Board rev 2559/);
  const after = await read(dataDir);
  for (const id of ["p389", "p357", "p401"]) assert.equal(find(after.plan, id)?.status, "done", id);
});

test("closes the 24 h replay keeps: a run of rows, a quoted answer, a tool's own description and a commit on a shared branch name no unfinished land", () => {
  const open = { status: "doing" as const };
  assert.equal(unlandedClose(open, { status: "done", note: "Wave 6 read 622 of its 640 new rows by 17:35Z (217 ok, 405 error, 18 not yet run)." }), null, "launch main bro 10-13 p43");
  assert.equal(unlandedClose(open, { status: "done", note: "Every step is closed: p86 is done and run by the Chat system duty d1, and p342 was dropped " +
    "after the owner answered t45 with 'Not yet' on 10-13." }), null, "AI harness 10-13 p1");
  assert.equal(unlandedClose({ ...open, waitFor: "Fable's 'released' for the land 34 loop; then land 33 shepherd resumes the ship flow design" }, { status: "done",
    note: "Done: the one command is scripts/repo/agent/ship.mjs (217bbb6e4d: freeze, probe, wait for verify-dev, commit on green), with commit.mjs " +
      "--probed (7b534f14b0); all are in land 33 on origin/staging (f9f3a0f1c6, p97 and p115 checked 07:01Z)." }), null, "VP of CI 10-13 p89");
  assert.match(unlandedClose(open, { status: "done", note: "Closed 04:44Z: every demo step of this goal is done, and the last land rides the thread demo " +
    "stack next, which packs the next stack and lands it after r21." }) ?? "", /^its note says/, "frontend bro 10-14 p103 hands its last land to another thread");
});
