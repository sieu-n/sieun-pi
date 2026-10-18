// Guards d7 stuck_steps_all on 10-18: at 16:31Z Crawler VP's p542 waited for "the next land and promote 13 carry bf3ebaf4fa, ..." and counted
// stuck on a release while "land 39 rerun" slept on land 40's run 39144738917, whose pin e375b4cc0a carries all five commits it names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endState } from "../src/checkin-end-state.ts";
import { landCarries, parseTrain, wakeWatches } from "../src/checkin-load.ts";
import { stepView } from "../src/checkin-steps.ts";
import type { Wake } from "../src/wakes.ts";
import type { PlanItem } from "../src/shared/types.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const DRIVER = "01a14fbe-a688-753d-857e-00b8f4dd992e";
const RUN = 39144738917;

function repoWith(dir: string): { carried: string; later: string; head: string } {
  // Fixed dates give the same commit ids on every run, so a 10-character id always has a digit and a letter.
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-10-18T16:00:00Z", GIT_COMMITTER_DATE: "2026-10-18T16:00:00Z", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "dev");
  git("commit", "-q", "--allow-empty", "-m", "fix(query): mcp tools");
  const carried = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "land 40 pin");
  const head = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "fix(obs): delete the backend warning lines");
  return { carried, later: git("rev-parse", "HEAD"), head };
}

const step = (id: string, waitFor: string, job: string, sessionId: string): PlanItem => ({ id, text: id, status: "doing", children: [], job, sessionId, waitFor });

test("a land wait is moved by the session asleep on the land run that carries every commit it names, and stuck when no watched land does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "land-carries-"));
  try {
    const { carried, later, head } = repoWith(dir);
    const now = Date.parse("2026-10-18T16:31:45Z");
    const train = parseTrain({ fetchedAt: "2026-10-18T16:31:30Z", runs: { [RUN]: { run: { id: RUN, name: "land: land 40: e375b4cc0a tip", path: ".github/workflows/land.yml",
      head_branch: "dev", head_sha: head, status: "in_progress", conclusion: null, created_at: "2026-10-18T16:22:58Z", updated_at: "2026-10-18T16:30:00Z" } } } })!;
    const wakes: Wake[] = [{ session: DRIVER, on: { kind: "run", run: RUN }, note: "land 40 finished: then promote 13", since: now - 600_000 }];
    const mcp = step("p542", `the next land and promote 13 carry ${carried.slice(0, 10)}; then query mcp build sets mcpAccess`, "query mcp build", "01a14d5d-e1af-762b-884a-6c2c89c4419b");
    const alert = step("p781", `the next land and promote that carry ${later.slice(0, 10)}, whose obs deploy drops the rule from Grafana`, "alert Crawler VP 22:11", "01a14f23-168c-705d-9071-f9f317f895eb");
    const watches = wakeWatches(wakes, train, await landCarries([mcp, alert], wakes, train, dir));
    const rows = [{ id: DRIVER, name: "land 39 rerun", archived: false }];
    const self = new Set([CHAT]);
    const state = (item: PlanItem) => endState(stepView(item, now - 900_000, self, [], [], rows, now), [], rows, self, now, [], { watches });
    assert.deepEqual([state(mcp).state, state(mcp).reason], ["moving", `its wait is on ${carried.slice(0, 10)}, which land 40 carries and land 39 rerun sleeps on a board.wake on run ${RUN}`]);
    assert.equal(state(alert).state, "release");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
