import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Skills } from "../../server/skills.ts";
import { SkillsReview, unifiedDiff } from "../../server/skills-review.ts";
import { writeFixtureSet, type FixtureSet } from "../../server/skills-review-fixture.ts";
import type { ReviewEvent } from "../../web/src/lib/api/shared/skills-review.ts";

const PLUGIN = "plugin:Claude Code plugin chart-kit";

function rig(t: { after: (fn: () => void) => void }): { review: SkillsReview; set: FixtureSet; events: ReviewEvent[]; folds: string[]; base: string } {
  const base = mkdtempSync(join(tmpdir(), "skills-review-test-"));
  const reviewDir = join(base, "review-dir");
  const set = writeFixtureSet(join(base, "root"), { reviewDir, name: "t" });
  const events: ReviewEvent[] = [];
  const folds: string[] = [];
  const review = new SkillsReview({ dir: reviewDir, fixture: false, macHost: null }, new Skills({ inventory: join(base, "none.json"), scanner: null }, "us-metal02"), "us-metal02", {
    log: () => {}, broadcast: event => events.push(event), fold: async text => void folds.push(text),
  });
  t.after(() => {
    review.stop();
    rmSync(base, { recursive: true, force: true });
  });
  return { review, set, events, folds, base };
}

const moves = (set: FixtureSet): Record<string, unknown>[] => {
  const file = join(set.stateDir, "moves.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
};

test("items group by skill name, plugin skills by their plugin, and each lists its keep copies", async t => {
  const { review } = rig(t);
  const report = await review.report("t");
  assert.equal(report.set, "t");
  assert.deepEqual(report.items.map(item => item.id).sort(), ["plugin:Claude Code plugin chart-kit", "skill:board-rules", "skill:deploy-notes", "skill:old-helper", "skill:release-steps", "skill:screen-notes"]);
  const plugin = report.items.find(item => item.id === PLUGIN)!;
  assert.equal(plugin.unit, "plugin");
  assert.equal(plugin.copies, 3);
  const deploy = report.items.find(item => item.id === "skill:deploy-notes")!;
  assert.equal(deploy.copies, 3, "the keep copy is listed beside the two to delete");
  assert.equal(deploy.toAct, 2);
  assert.deepEqual(report.counts, { items: 6, pending: 6, approved: 0, kept: 0, skipped: 0 });
  assert.deepEqual(report.mac, { host: null, online: null, checkedAt: null, queued: 0 });
});

test("an item diffs each copy against the keeper, and shows the text where the diff is empty or no keeper exists", async t => {
  const { review, set } = rig(t);
  const item = await review.item("t", "skill:deploy-notes");
  const keeper = item.copyRows.find(copy => copy.keeper)!;
  assert.equal(keeper.path, join(set.root, "home/src/tools/skills/deploy-notes"));
  const codex = item.copyRows.find(copy => copy.path.includes(".codex"))!;
  const claude = item.copyRows.find(copy => copy.path.includes(".claude"))!;
  assert.equal(codex.how, "trash");
  assert.match(item.diffs[codex.id] ?? "", /^-2\. Push to main\.$/m);
  assert.match(item.diffs[codex.id] ?? "", /^\+2\. Ask for a review\.$/m);
  assert.equal(item.diffs[claude.id], "");
  assert.match(item.texts[claude.id] ?? "", /name: deploy-notes/);
  const fold = await review.item("t", "skill:release-steps");
  assert.equal(fold.copyRows[0]!.action, "fold");
  assert.equal(fold.copyRows[0]!.foldInto, "deploy-notes");
  assert.equal(fold.copyRows[0]!.how, "fold-job");
  assert.match(fold.texts[fold.copyRows[0]!.id] ?? "", /Tag the release/);
});

test("approve moves trash copies with a backup and a log line, a second approve changes nothing, and undo puts them back", async t => {
  const { review, set, events } = rig(t);
  const codexDir = join(set.root, "home/.codex/skills/deploy-notes");
  const claudeDir = join(set.root, "home/.claude/skills/deploy-notes");
  const first = await review.decide({ set: "t", id: "skill:deploy-notes", action: "approve" });
  assert.equal(first.item.status, "approved");
  assert.ok(!existsSync(codexDir) && !existsSync(claudeDir));
  const applied = first.item.copyRows.filter(copy => copy.state === "applied");
  assert.equal(applied.length, 2);
  assert.equal(moves(set).length, 2);
  const backup = moves(set).find(line => line.path === codexDir)!.backup as string;
  assert.match(readFileSync(join(backup, "SKILL.md"), "utf8"), /Ask for a review/);
  assert.ok(events.some(event => event.id === "skill:deploy-notes"));
  assert.match(first.item.diffs[first.item.copyRows.find(copy => copy.path === codexDir)!.id] ?? "", /Ask for a review/, "the diff still reads the moved copy from its backup");

  const second = await review.decide({ set: "t", id: "skill:deploy-notes", action: "approve" });
  assert.deepEqual(second.item.copyRows.map(copy => copy.state), first.item.copyRows.map(copy => copy.state));
  assert.equal(moves(set).length, 2, "the second approve took no step");

  const undone = await review.undo({ set: "t", id: "skill:deploy-notes" });
  assert.equal(undone.item.status, "undone");
  assert.equal(undone.item.decision, null);
  assert.match(readFileSync(join(codexDir, "SKILL.md"), "utf8"), /Ask for a review/);
  assert.ok(existsSync(claudeDir));
  assert.equal(moves(set).length, 4);
  await review.undo({ set: "t", id: "skill:deploy-notes" });
  assert.equal(moves(set).length, 4, "a second undo took no step");
  assert.equal(undone.counts.pending, 6);
});

test("a git copy goes in a commit of only its path; a failed push keeps the commit; the Mac copy follows it; undo commits it back", async t => {
  const { review, set } = rig(t);
  const repo = join(set.root, "repo");
  writeFileSync(join(repo, "README.md"), "another session's edit\n");
  const result = await review.decide({ set: "t", id: "skill:old-helper", action: "approve" });
  const local = result.item.copyRows.find(copy => copy.box === "us-metal02")!;
  const mac = result.item.copyRows.find(copy => copy.box === "mac")!;
  assert.equal(local.how, "git");
  assert.equal(local.state, "applied");
  assert.match(local.note ?? "", /Push failed/);
  assert.equal(mac.how, "follows-git");
  assert.equal(mac.state, "applied");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]).toString().trim();
  assert.equal(git("ls-files", "--", "skills/old-helper"), "");
  assert.equal(git("show", "--name-only", "--format=", "HEAD"), "skills/old-helper/SKILL.md", "the commit holds only the skill's path");
  assert.equal(git("status", "--porcelain", "--", "README.md"), "M README.md", "another session's edit stays out of the commit");
  const commit = git("rev-parse", "HEAD");
  assert.ok(moves(set).some(line => line.commit === commit));
  assert.match(mac.note ?? "", new RegExp(commit.slice(0, 8)));

  const undone = await review.undo({ set: "t", id: "skill:old-helper" });
  assert.equal(git("ls-files", "--", "skills/old-helper"), "skills/old-helper/SKILL.md");
  assert.match(git("log", "-1", "--format=%s"), /restore skills\/old-helper/);
  assert.ok(undone.item.copyRows.every(copy => copy.state === "undone"));
  await review.undo({ set: "t", id: "skill:old-helper" });
  assert.match(git("log", "-1", "--format=%s"), /restore skills\/old-helper/, "a second undo made no commit");
});

test("a harness note leaves its store under the lock with a backup, and undo puts the entry back", async t => {
  const { review, set } = rig(t);
  const store = () => JSON.parse(readFileSync(join(set.harnessStore, "harness_state.json"), "utf8")) as { entries: { memory: Record<string, { content: string }> } };
  const item = await review.item("t", "skill:board-rules");
  const note = item.copyRows.find(copy => copy.path.startsWith("harness:"))!;
  assert.equal(note.how, "harness");
  assert.match(item.diffs[note.id] ?? "", /^-Close a step once its sha is released\.$/m);
  const result = await review.decide({ set: "t", id: "skill:board-rules", action: "approve" });
  assert.equal(result.item.copyRows.find(copy => copy.id === note.id)!.state, "applied");
  assert.equal(store().entries.memory.fixture_board_note, undefined);
  assert.ok(!existsSync(join(set.harnessStore, "harness_state.json.lock")), "the lock is released");
  await review.decide({ set: "t", id: "skill:board-rules", action: "approve" });
  await review.undo({ set: "t", id: "skill:board-rules" });
  assert.equal(store().entries.memory.fixture_board_note?.content, "Keep each board step to one line.");
});

test("a set refuses to touch a path outside its root", async t => {
  const { review, set, base } = rig(t);
  const outside = join(base, "outside/skills/stray");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SKILL.md"), "---\nname: stray\n---\n");
  const inventory = JSON.parse(readFileSync(set.inventory, "utf8")) as { skills: Record<string, unknown>[] };
  inventory.skills.push({ id: `us-metal02:${outside}`, name: "stray", box: "us-metal02", path: join(outside, "SKILL.md"), dir: outside, family: "user:.claude/skills", useful: { verdict: "remove", reason: "x", action: true }, loadedBy: { how: ["~/.claude/skills"] } });
  writeFileSync(set.inventory, JSON.stringify(inventory));
  const result = await review.decide({ set: "t", id: "skill:stray", action: "approve" });
  const copy = result.item.copyRows[0]!;
  assert.equal(copy.state, "failed");
  assert.match(copy.note ?? "", /^Refused: .* is outside the set's root/);
  assert.ok(existsSync(join(outside, "SKILL.md")), "the stray skill is still there");
});

test("a Mac copy stays queued when the set names no Mac host, and undo drops the step that never ran", async t => {
  const { review, set } = rig(t);
  const result = await review.decide({ set: "t", id: "skill:screen-notes", action: "approve" });
  assert.equal(result.item.copyRows[0]!.state, "queued");
  assert.equal(result.item.queued, true);
  assert.match(result.item.copyRows[0]!.note ?? "", /names no Mac host/);
  const report = await review.report("t");
  assert.equal(report.mac.queued, 1);
  assert.equal(report.mac.online, null);
  assert.ok(existsSync(join(set.root, "mac/Users/owner/.claude/skills/screen-notes/SKILL.md")), "nothing ran on the Mac copy");
  await review.decide({ set: "t", id: "skill:screen-notes", action: "approve" });
  assert.equal((await review.report("t")).mac.queued, 1, "a second approve queues no second step");
  const undone = await review.undo({ set: "t", id: "skill:screen-notes" });
  assert.equal(undone.item.copyRows[0]!.state, "undone");
  assert.equal((await review.report("t")).mac.queued, 0);
});

test("a fold on a set other than live logs to folds.jsonl and messages no agent; keep with a changed target puts nothing in motion", async t => {
  const { review, set, folds } = rig(t);
  const item = await review.item("t", "skill:release-steps");
  const copy = item.copyRows[0]!.id;
  const result = await review.decide({ set: "t", id: "skill:release-steps", action: "approve", overrides: { [copy]: { action: "fold", foldInto: "board-rules" } } });
  assert.equal(result.item.copyRows[0]!.foldInto, "board-rules");
  assert.equal(result.item.copyRows[0]!.state, "applied");
  assert.equal(folds.length, 0);
  const lines = readFileSync(join(set.stateDir, "folds.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { foldInto: string; kind: string });
  assert.deepEqual(lines.map(line => [line.kind, line.foldInto]), [["fold", "board-rules"]]);
  const kept = await review.decide({ set: "t", id: "skill:release-steps", action: "keep" });
  assert.equal(kept.item.status, "kept");
  assert.equal(kept.item.copyRows[0]!.state, "undone", "keep puts back the applied fold");
  await assert.rejects(review.decide({ set: "t", id: "skill:release-steps", action: "approve", overrides: { nope: { action: "delete" } } }), /No copy nope/);
});

const sshLocal = (() => {
  try {
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "localhost", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("the Mac queue runs its steps over ssh, here against localhost, and undo brings the folder back the same way", { skip: !sshLocal && "no ssh to localhost" }, async t => {
  const { set, base } = rig(t);
  writeFileSync(set.setFile, JSON.stringify({ ...JSON.parse(readFileSync(set.setFile, "utf8")), macHost: "localhost" }));
  const review = new SkillsReview({ dir: join(base, "review-dir"), fixture: false, macHost: null }, new Skills({ inventory: join(base, "none.json"), scanner: null }, "us-metal02"), "us-metal02", {
    log: () => {}, broadcast: () => {}, fold: async () => {},
  });
  t.after(() => review.stop());
  const dir = join(set.root, "mac/Users/owner/.claude/skills/screen-notes");
  const settled = async (state: string) => {
    for (let i = 0; i < 100 && (await review.item("t", "skill:screen-notes")).copyRows[0]!.state !== state; i++) await new Promise(done => setTimeout(done, 100));
    return review.item("t", "skill:screen-notes");
  };
  await review.decide({ set: "t", id: "skill:screen-notes", action: "approve" });
  const applied = await settled("applied");
  assert.equal(applied.copyRows[0]!.state, "applied");
  assert.ok(!existsSync(dir));
  const report = await review.report("t");
  assert.equal(report.mac.online, true);
  assert.equal(report.mac.queued, 0);
  await review.undo({ set: "t", id: "skill:screen-notes" });
  const undone = await settled("undone");
  assert.equal(undone.copyRows[0]!.state, "undone");
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /screen recording/);
});

test("unifiedDiff gives hunks with context and nothing for the same text", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "x", "y"), "");
  const diff = unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n", "1\n2\n3\n4\nfive\n6\n7\n8\n9\n", "x", "y");
  assert.equal(diff, "--- x\n+++ y\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n");
});
