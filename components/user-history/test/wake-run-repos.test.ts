// Guards d7's queue_holds_30 at 11:46Z on 10-18: two slack-green jobs set board.wake on runs 39123561025 and 39123644786 with no repo, the CI
// cache did not hold them, every read in its repo answered 404, and the finished runs held their wakes 12 and 13 min.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_CACHE_REPO, readRunState } from "../src/wakes.ts";

const NOT_CACHED = "ci-run-status: run 39123561025 is not in the cache (it holds runs created since 2026-10-18T10:43:31Z, live runs and runs asked for)";
const notFound = (repo: string) => `failed to get run: HTTP 404: Not Found (https://api.github.com/repos/${repo}/actions/runs/39123561025?exclude_pull_requests=true)`;
const DONE = JSON.stringify({ status: "completed", conclusion: "success", url: "https://github.com/sieu-n/slack-green/actions/runs/39123561025", workflowName: "CI", headBranch: "main" });

function fakeExec(runs: Record<string, string>, asked: string[]) {
  return async (command: string, args: string[]): Promise<string> => {
    if (command === "ci-run-status") throw new Error(NOT_CACHED);
    const repo = args[args.indexOf("--repo") + 1]!;
    asked.push(repo);
    if (runs[repo]) return runs[repo]!;
    throw new Error(notFound(repo));
  };
}

test("a run with no repo that the cache's repo does not have is read in the next repo that has it", async () => {
  const asked: string[] = [];
  const state = await readRunState({ kind: "run", run: 39123561025 }, fakeExec({ "sieu-n/slack-green": DONE }, asked));
  assert.deepEqual(state, { done: true, conclusion: "success", url: "https://github.com/sieu-n/slack-green/actions/runs/39123561025", label: "CI on main" });
  assert.deepEqual(asked, [CI_CACHE_REPO, "sieu-n/slack-green"]);
});

test("a run no repo has still reads as an error, and an error other than 404 stops at once", async () => {
  const asked: string[] = [];
  await assert.rejects(readRunState({ kind: "run", run: 39123561025 }, fakeExec({}, asked)), /HTTP 404/);
  assert.equal(asked.length, 3);
  const rateLimited = async (command: string): Promise<string> => { if (command === "ci-run-status") throw new Error(NOT_CACHED); throw new Error("HTTP 403: API rate limit exceeded"); };
  await assert.rejects(readRunState({ kind: "run", run: 39123561025 }, rateLimited), /403/);
});
