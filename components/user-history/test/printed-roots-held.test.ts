import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { jobFacts } from "../src/checkin-steps.ts";
import { jobRegistry, registerPrintedRoots } from "../src/chat-sources.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

/*
 * AI harness developer environment VP (chat 01a1164b), 10-14. The 15:01 KST check-in started its land jobs with
 * `rlm.create_session(b, name=name, cwd=cwd)` in a loop and printed each handle. tool_call found no literal name, so the job registry never
 * listed them, and the 17:01 and 19:02 check-ins flagged p200 and p243 as held_elsewhere: their open steps p389, p402, p409 and p357 are
 * owned by skill rules land, skill rewrite land and stale tree guard land, which read as other threads. The extension now registers the names
 * the printed handles show (`registerPrintedRoots`). PRINTED is that cell's output.
 */
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const NAME = "AI harness developer environment VP";
const NOW = Date.parse("2026-10-14T10:02:00Z");
const RULES = { job: "skill rules land", sessionId: "01a13903-e4ac-77c9-9ebc-76a8a5a5560f" };
const GUARD = { job: "stale tree guard land", sessionId: "01a13904-0527-73b8-ab31-a76ac4170a70" };
const REWRITE = { job: "skill rewrite land", sessionId: "01a13904-5c28-743d-a0eb-fe8f9a6c971e" };
const handle = (active: string, root: { job: string; sessionId: string }): string => `${root.job} RLMCreateSessionHandle(active_session_id='${active}', ` +
  `session_id='${root.sessionId}', name='${root.job}', session_file=PosixPath('/Users/sieunpark/.prime/agent/sessions/${root.sessionId}.jsonl'), cwd='/repo')`;
const PRINTED = [handle("e5b729472168", RULES), handle("cd6487ddf453", GUARD),
  handle("0e144173a7f5", { job: "github signin land", sessionId: "01a13904-3b07-77c6-9d7b-f6b2456467dc" }), handle("6884d0b9e5de", REWRITE)].join("\n");

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const PLAN: PlanItem[] = [
  step("p200", "llm-wiki is reliable and every page reads like a plain blog article", "todo", { children: [step("p224", "Wiki index fix", "done"),
    step("p389", "Land the new skill rules for shared git, heavy work on the Mac and CI-only traps", "doing", { ...RULES,
      waitFor: "verify-dev run 38529531177 goes green; skill rules land lands it with --probed" })] }),
  step("p243", "Many agents can work in the shared repo at once without breaking each other", "todo", { children: [step("p316", "Shared tree sync", "done"),
    step("p402", "Agents finish GitHub sign-ins in Aside like other logins, by the owner's 10-14 choice", "doing", { ...REWRITE,
      waitFor: "batch A (run 38529446596) lands with the agent-auth sign-in row" }),
    step("p409", "Delete the search, crawler and research agent repo skills, and rewrite every agent-written skill", "doing", { ...REWRITE,
      waitFor: "verify-dev run 38529446596 goes green and batch A lands; batch B follows skill rules land" }),
    step("p357", "Block commits that would quietly undo newer changes to the same file", "doing", { ...GUARD,
      waitFor: "verify-dev run 38529486999 goes green; stale tree guard land lands it with --probed before promote 10's hold" })] }),
];
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", lastActivityAt: "2026-10-14T09:40:00Z", ...extra });
const ROWS = [row(CHAT, NAME, { working: true }), row(RULES.sessionId, RULES.job), row(GUARD.sessionId, GUARD.job), row(REWRITE.sessionId, REWRITE.job)];
const held = (jobs: string[]): string[] => {
  const chat: ChatBoard = { v: 2, rev: 2620, updatedAt: "2026-10-14T09:50:00Z", todos: [], plan: PLAN };
  const result = checkInPrecheck(undefined, jobFacts([], chat, ROWS, CHAT), chat, NOW, { self: [CHAT, NAME], rows: ROWS, jobs });
  return convergenceMisses(CHAT, result.steps, result, {}, 15 * 60_000, NOW).flagged.filter(slice => slice.kind === "held_elsewhere").map(slice => slice.item!);
};

test("AI harness 10-14 19:02: roots a check-in started under computed names are registered from their printed handles, so p200 and p243 are not held elsewhere", async () => {
  assert.deepEqual(held([]), ["p200", "p243"], "with no registry entry the land jobs read as other threads, as at 17:01 and 19:02");
  const registry = jobRegistry(join(await mkdtemp(join(tmpdir(), "printed-roots-")), "chat-jobs.json"), () => NOW);
  assert.deepEqual(await registerPrintedRoots(registry, PRINTED, NAME), ["skill rules land", "stale tree guard land", "github signin land", "skill rewrite land"]);
  const jobs = await registry.rootsOf([CHAT, NAME]);
  assert.deepEqual(held(jobs), []);
  assert.deepEqual(await registerPrintedRoots(registry, "no handle here", NAME), [], "a result with no handle registers nothing");
});
