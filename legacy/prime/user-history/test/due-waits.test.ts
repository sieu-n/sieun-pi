// Guards d9 stuck_steps_all on 11-09: metal-management's p232 sat blocked 6.5 days on "A prod promote carrying 6c413ea27; promote 22 (main
// b1fb45b230, 11-02 17:35Z) did not include it", while promote 22's b1fb45b230 held it. Staging lands are one-parent commits with a
// Land-From trailer, so 6c413ea27 was no ancestor of main and every step with a waitFor read as held on purpose.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dueWaits, dueWords, landCarry, parseLands, waitOnCommits } from "../scripts/duties/due-waits.ts";
import { pushItems, withDueWaits } from "../scripts/duties/chat-system.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
const OWNER = "01a11d24-ac9b-757d-ac51-9b2b7598782f";

/** dev/sieun with the fix and a later commit, staging with one land of the fix's tip, and main promoted to that land, as on 11-02. */
function trainWith(dir: string): { fix: string; later: string; land: string } {
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-10-30T11:54:24Z", GIT_COMMITTER_DATE: "2026-10-30T13:21:07Z", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "dev/sieun");
  git("commit", "-q", "--allow-empty", "-m", "chore: base");
  const base = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "fix(crawler-v3): a post whose page Instagram deleted leaves the content index");
  const fix = git("rev-parse", "HEAD");
  const land = git("commit-tree", `${fix}^{tree}`, "-p", base, "-m", `land: dev/sieun ${fix.slice(0, 9)}\n\nLand-From: dev/sieun ${fix}`);
  git("update-ref", "refs/remotes/origin/staging", land);
  git("update-ref", "refs/remotes/origin/main", land);
  git("commit", "-q", "--allow-empty", "-m", "fix(search): a later commit no land holds");
  return { fix, later: git("rev-parse", "HEAD"), land };
}

const step = (id: string, waitFor: string, extra: Partial<PlanItem> = {}): PlanItem =>
  ({ id, text: `step ${id}`, status: "blocked", children: [], job: OWNER, sessionId: OWNER, waitFor, ...extra });

test("a wait on a promote whose squash-landed commit main already holds is due, while ancestry misses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "due-waits-"));
  try {
    const { fix, later, land } = trainWith(dir);
    assert.throws(() => execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", fix, "origin/main"], { stdio: "ignore" }));
    const p232 = step("p232", `A prod promote carrying ${fix.slice(0, 9)}; promote 22 (main ${land.slice(0, 10)}, 11-02 17:35Z) did not include it`);
    const later1 = step("p233", `the next promote carrying ${later.slice(0, 9)}`);
    const held = step("p234", `A prod promote carrying ${fix.slice(0, 9)}, and the owner's answer on t5`);
    const deploy = step("p235", `staging-deploy run 42547308421 of land ${land.slice(0, 10)}`);
    const board: ChatBoard = { plan: [p232, later1, held, deploy], todos: [{ id: "t5", text: "Run the prod repairs?", done: false, from: "agent" }] } as unknown as ChatBoard;
    const due = await dueWaits(new Map([[CHAT, board]]), landCarry(dir));
    assert.deepEqual(due.map(entry => [entry.id, entry.branch, entry.land?.commit]), [["p232", "main", land]]);
    assert.equal(dueWords(due[0]!), `main carries ${fix.slice(0, 9)} since land ${land.slice(0, 10)} (2026-10-30)`);
    const stuck = withDueWaits([], due.map(entry => ({ chat: entry.chat, id: entry.id, text: entry.text, why: dueWords(entry) })));
    assert.deepEqual(stuck.map(entry => entry.id), ["p232"]);
    assert.match(pushItems({ chat: CHAT, goals: [], steps: stuck, duties: [], upkeep: [] }), /p232 "step p232" \(its wait is over: main carries [0-9a-f]{9} since land/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a land wait reads staging, a promote or prod wait reads main, and a deploy or a wait with no commit reads neither", () => {
  assert.deepEqual(waitOnCommits("land 37 (19f6a5cc94) reaches staging, then promote 11 reaches prod"), { branch: "staging", commits: ["19f6a5cc94"] });
  assert.deepEqual(waitOnCommits("9c8dc6f7f9 (in land 37) reaches prod"), { branch: "main", commits: ["9c8dc6f7f9"] });
  assert.equal(waitOnCommits("staging-deploy run 42547308421 of land 716593c570"), undefined);
  assert.equal(waitOnCommits("promote 27 serves"), undefined);
  assert.equal(waitOnCommits("old convex cleanups metal's subagents: staging factsKept end, restateBrandNames on 6356eb72db; prod runs on the next promote"), undefined);
});

test("a land's tips come from its title and its Land-From trailers, oldest land first", () => {
  const log = ["a".repeat(40), "2026-11-02T17:35:00Z", "land: dev/sieun 45ed4afb3", `dev/sieun ${"4".repeat(39)}5`].join("\x1f") + "\x1e\n" +
    ["b".repeat(40), "2026-10-19T09:47:28Z", "land 52: 3fd4df15f4 tip (backup dispatch)", ""].join("\x1f") + "\x1e\n" +
    ["c".repeat(40), "2026-10-18T00:00:00Z", "fix: not a land", ""].join("\x1f") + "\x1e";
  assert.deepEqual(parseLands(log), [
    { commit: "b".repeat(40), at: "2026-10-19T09:47:28Z", tips: ["3fd4df15f4"] },
    { commit: "a".repeat(40), at: "2026-11-02T17:35:00Z", tips: [`${"4".repeat(39)}5`, "45ed4afb3"] },
  ]);
});
