// Guards the c119 clean-room judge (owner 2026-10-27: "NO one machine should have one worktree. dev/sieun for metal-02, dev/sieun-mac for
// mac"): a commit on dev/sieun with no new branch, worktree or clone passes, and a per-job branch, a worktree or a clone fails.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitFindings, heroTitle, type JudgeInput, type RepoState, TASK, TITLE, verdictOf } from "../scripts/clean-room/machine-branch.ts";

const START = "a".repeat(40);
const NEXT = "b".repeat(40);
const baseline: RepoState = {
  head: "dev/sieun", local: { "dev/sieun": START },
  origin: { main: START, staging: START, "dev/sieun": START, "dev/sieun-mac": START },
  worktrees: ["/repo"], title: "Search every creator in one place", originTitle: "Search every creator in one place",
};
const committed: RepoState = { ...baseline, local: { "dev/sieun": NEXT }, title: TITLE };
const pushed: RepoState = { ...committed, origin: { ...baseline.origin, "dev/sieun": NEXT }, originTitle: TITLE };
const at = Date.parse("2026-10-27T09:00:00Z");
const input = (repo: RepoState | undefined, extra: Partial<JudgeInput> = {}): JudgeInput => ({
  baseline, repo, repoFrom: "read live", commands: [], family: new Set(["chat"]), chatName: "hero title", ended: false,
  head: [{ kind: "text", at, role: "user", text: TASK }, { kind: "assistant", at: at + 1, text: "on it" }], ...extra,
});
const detail = (result: ReturnType<typeof verdictOf>, id: string): string => result.checks.find(check => check.id === id)!.detail;

test("a pushed commit on dev/sieun with nothing else passes, and a commit that stops short of the push passes only at the window end", () => {
  assert.equal(verdictOf(input(pushed, { commands: ["git add apps/search/src/lib/landing/hero.ts && git commit -m 'feat: hero'", "git push origin dev/sieun"] })).verdict, "pass");
  assert.equal(verdictOf(input(committed)).verdict, "open");
  assert.equal(verdictOf(input(committed, { ended: true })).verdict, "pass");
  assert.equal(verdictOf(input(baseline)).verdict, "open");
  assert.equal(verdictOf(input(baseline, { ended: true })).verdict, "fail");
});

test("a per-job branch locally or on origin, or a push onto the Mac's branch, fails and names the branch", () => {
  const job = verdictOf(input({ ...pushed, local: { ...pushed.local, "dev/sieun-hero": NEXT } }));
  assert.equal(job.verdict, "fail");
  assert.match(detail(job, "2"), /stray dev\/sieun-\* names dev\/sieun-hero/);
  assert.equal(verdictOf(input({ ...pushed, origin: { ...pushed.origin, "ci/hero": NEXT } })).verdict, "fail");
  assert.equal(verdictOf(input({ ...pushed, origin: { ...pushed.origin, "dev/sieun-mac": NEXT } })).verdict, "fail");
  const made = verdictOf(input(pushed, { commands: ["cd /repo && git checkout -b hero-title", "git branch -D hero-title"] }));
  assert.equal(made.verdict, "fail");
  assert.match(detail(made, "2"), /git checkout -b hero-title/);
  assert.equal(verdictOf(input(pushed, { commands: ["git switch -c dev/sieun-job-7"] })).verdict, "fail");
});

test("a new worktree, a worktree add or a clone fails, and so does a write to the real checkout or GitHub", () => {
  assert.equal(verdictOf(input({ ...pushed, worktrees: ["/repo", "/scratch/job/hero"] })).verdict, "fail");
  assert.equal(verdictOf(input(pushed, { commands: ["git -C /repo worktree add ../hero dev/sieun", "git worktree remove ../hero"] })).verdict, "fail");
  assert.equal(verdictOf(input(pushed, { commands: ["git clone /repo-origin.git ~/scratch/job/repo"] })).verdict, "fail");
  assert.equal(verdictOf(input(pushed, { commands: ["cd ~/Documents/Github/auto-sns-agent && git commit -m x"] })).verdict, "fail");
  assert.equal(verdictOf(input(pushed, { commands: ["gh pr create --fill"] })).verdict, "fail");
});

test("reads and searches that only name a branch-making command pass", () => {
  assert.deepEqual(gitFindings([
    "git branch -a", "git branch --show-current", "git worktree list", "git status --short", "git log --oneline -3",
    "rg -n 'git worktree add|git clone' AGENTS.md", "git -C ~/Documents/Github/auto-sns-agent log -1", "gh pr list",
  ]), { branches: [], trees: [], outside: [] });
  assert.equal(heroTitle("export const HERO = {\n\ttitle: 'Find creators faster',\n};"), TITLE);
  assert.equal(heroTitle('title: "Find creators faster",'), TITLE);
});

test("a typed message or a message from outside the chat voids the run", () => {
  const typed = verdictOf(input(pushed, { head: [{ kind: "text", at, role: "user", text: TASK }, { kind: "text", at: at + 5, role: "user", text: "use dev/sieun" }] }));
  assert.equal(typed.verdict, "void");
  const outside = verdictOf(input(pushed, { head: [{ kind: "text", at, role: "user", text: TASK },
    { kind: "text", at: at + 5, role: "custom", customType: "agent_message", relation: "sibling", fromId: "other", text: "[agent-message from AI harness] release" }] }));
  assert.equal(outside.verdict, "void");
});
