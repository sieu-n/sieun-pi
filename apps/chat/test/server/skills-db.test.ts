import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SkillsDb } from "../../server/skills-db.ts";
import { fixtureScanner, writeSkillsDbFixture, type SkillsDbFixture } from "../../server/skills-db-fixture.ts";
import { changedLines, similarity } from "../../server/skills-model.ts";
import { SkillsReview } from "../../server/skills-review.ts";
import { Skills } from "../../server/skills.ts";
import type { SkillScan } from "../../web/src/lib/api/shared/skills.ts";

const REPO = resolve(import.meta.dirname, "../../../..");
const BOX = "us-metal02";
const IDLE: SkillScan = { running: false, startedAt: null, endedAt: null, error: null };

type Rig = { fixture: SkillsDbFixture; db: SkillsDb; review: SkillsReview; scan: () => void; present: (path: string) => boolean };

function rig(t: { after: (fn: () => void) => void }): Rig {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-"));
  const reviewDir = join(dir, "review");
  const fixture = writeSkillsDbFixture(join(dir, "tree"), { reviewDir, box: BOX });
  const review = new SkillsReview({ dir: reviewDir, fixture: false, macHost: null }, new Skills({ inventory: join(dir, "none.json"), scanner: null }, BOX), BOX, {
    log: () => {}, broadcast: () => {}, fold: async () => {},
  });
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: fixture.home, piHostPrompt: null }, review.diskSteps(fixture.setName));
  const scanner = fixtureScanner(fixture, REPO);
  const scan = () => {
    execFileSync(scanner.command, scanner.args, { cwd: scanner.cwd, env: { ...process.env, ...scanner.env }, stdio: "ignore" });
    assert.ok(db.ingest(JSON.parse(readFileSync(fixture.inventory, "utf8"))));
  };
  const present = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => {
    review.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fixture, db, review, scan, present };
}

test("the first scan seeds the DB from the disk, so check finds no drift and apply changes nothing, twice", async t => {
  const { db, scan } = rig(t);
  scan();
  const view = db.view(IDLE);
  assert.ok(view.seededAt);
  assert.equal(view.counts.drift, 0, JSON.stringify(db.check().items));
  assert.equal(view.unowned.length, 0);
  const first = await db.apply();
  assert.equal(first.changes, 0);
  const second = await db.apply();
  assert.equal(second.changes, 0);
  scan();
  assert.equal((await db.apply()).changes, 0, "a rescan of an unchanged disk changes nothing either");
  const deploy = view.skills.find(s => s.id === "git:tools/.agents/skills/deploy-notes");
  assert.ok(deploy, view.skills.map(s => s.id).join(", "));
  assert.equal(deploy.installs.length, 1);
  assert.equal(deploy.installs[0]!.mode, "link");
  assert.deepEqual(deploy.copies.map(c => c.role).sort(), ["checkout", "install", "source"]);
});

test("rules: an old clone is stale, a same-text copy under another source merges, a near copy merges, a long skill is bloated, a dead link is broken", async t => {
  const { db, scan } = rig(t);
  scan();
  const view = db.view(IDLE);
  const rules = (id: string) => view.skills.find(s => s.id === id)?.verdicts.map(v => `${v.rule}:${v.action}`) ?? [];
  assert.ok(rules("git:tools/.agents/skills/deploy-notes").includes("stale-clone:note"));
  const copy = view.skills.find(s => s.source.kind === "local" && s.name === "deploy-notes")!;
  assert.ok(rules(copy.id).includes("duplicate:merge"), rules(copy.id).join(", "));
  const near = view.skills.find(s => s.name === "notes-helper")!;
  assert.ok(rules(near.id).includes("near-duplicate:merge"), rules(near.id).join(", "));
  assert.ok(rules("git:tools/.agents/skills/big-guide").includes("bloated:note"));
  const gone = view.skills.find(s => s.verdicts.some(v => v.rule === "broken"))!;
  assert.equal(gone.verdicts.find(v => v.rule === "broken")!.action, "remove");
  assert.ok(!rules("upstream:claude-plugin:chart-kit@fixture-market/bar-chart").some(r => r.endsWith(":remove")), "a plugin skill is never proposed for removal");
  assert.equal(view.counts.bloated, 1);
  assert.ok(view.counts.duplicated >= 2);
  assert.equal(view.boxes[0]!.state, "ok");
  assert.ok(view.boxes[0]!.tree.length > 0);
  assert.ok(view.thresholds.medianBytes > 0);
});

test("install places a link once, a second apply and a rescan change nothing, and undo takes it away again", async t => {
  const { fixture, db, scan, present } = rig(t);
  scan();
  const at = join(fixture.home, ".codex/skills/deploy-notes");
  const change = await db.install({ name: "deploy-notes", box: BOX, runtime: "codex" });
  assert.equal(change.apply?.changes, 1);
  assert.equal(readlinkSync(at), join(fixture.home, "src/tools/.agents/skills/deploy-notes"));
  assert.equal((await db.apply()).changes, 0);
  scan();
  assert.equal(db.check().items.length, 0, JSON.stringify(db.check().items));
  assert.equal((await db.apply()).changes, 0);
  const again = await db.install({ name: "deploy-notes", box: BOX, runtime: "codex" });
  assert.equal(again.apply?.changes, 0, "installing what is there changes nothing");
  await db.undo({ moveId: change.move.id });
  assert.equal(present(at), false);
  scan();
  assert.equal(db.check().items.length, 0);
  assert.equal(db.view(IDLE).skills.find(s => s.id === "git:tools/.agents/skills/deploy-notes")!.installs.length, 1);
});

test("a link deleted by hand shows as missing, apply puts it back, and the next apply does nothing", async t => {
  const { fixture, db, scan } = rig(t);
  scan();
  const link = join(fixture.home, ".prime/agent/skills/board-rules");
  rmSync(link);
  scan();
  assert.deepEqual(db.check().items.map(i => i.kind), ["missing"]);
  assert.equal((await db.apply({ dryRun: true })).changes, 1);
  assert.equal((await db.apply()).changes, 1);
  assert.equal(readlinkSync(link), join(fixture.home, "src/tools/.agents/skills/board-rules"));
  assert.equal((await db.apply()).changes, 0);
  scan();
  assert.equal(db.check().items.length, 0);
});

test("remove moves a copy into the review's trash with a moves.jsonl line, and undo puts it back", async t => {
  const { fixture, db, scan, present } = rig(t);
  scan();
  const dir = join(fixture.home, ".claude/skills/deploy-notes-copy");
  const change = await db.remove({ target: `${BOX}:${dir}` });
  assert.equal(present(dir), false);
  assert.match(readFileSync(join(fixture.root, "review-state/moves.jsonl"), "utf8"), /deploy-notes-copy/);
  scan();
  assert.equal(db.check().items.length, 0);
  await db.undo({ moveId: change.move.id });
  assert.ok(existsSync(join(dir, "SKILL.md")));
  scan();
  assert.equal(db.check().items.length, 0);
  assert.ok(db.moves().some(m => m.id === change.move.id && m.undoneAt));
});

test("a new folder after the seed is unowned until adopted, and adopt changes no file", async t => {
  const { fixture, db, scan } = rig(t);
  scan();
  execFileSync("mkdir", ["-p", join(fixture.home, ".claude/skills/fresh")]);
  execFileSync("sh", ["-c", `printf -- '---\\nname: fresh\\ndescription: New.\\n---\\n' > '${join(fixture.home, ".claude/skills/fresh/SKILL.md")}'`]);
  scan();
  const items = db.check().items;
  assert.deepEqual(items.map(i => i.kind), ["unowned"]);
  const item = items[0]!;
  assert.equal(item.kind, "unowned");
  if (item.kind === "unowned") await db.adopt({ copyId: item.copyId });
  assert.equal(db.check().items.length, 0);
  assert.equal((await db.apply()).changes, 0);
});

test("a box whose scan fails keeps its last good copies and says since when", t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-mac-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, { run: async () => [], undo: async () => [] });
  t.after(() => db.close());
  const copy = { box: "mac", path: "/Users/o/.claude/skills/a", realPath: "/Users/o/.claude/skills/a", linkTarget: null, exists: true, name: "a", source: "user-dir", root: "/Users/o/.claude/skills", runtimes: ["claude"], hash: "h1", text: "x" };
  db.ingest({ generatedAt: "2026-11-21T03:00:00Z", boxes: [{ box: "mac", scannedAt: "2026-11-21T03:00:00Z", ok: true }], copies: [copy], usage: {} });
  db.ingest({ generatedAt: "2026-11-21T04:00:00Z", boxes: [{ box: "mac", scannedAt: "2026-11-21T04:00:00Z", ok: false, error: "ssh exit 255: timed out" }], copies: [], usage: {} });
  const mac = db.view(IDLE).boxes.find(b => b.box === "mac")!;
  assert.equal(mac.state, "offline");
  assert.equal(mac.message, "Mac asleep or offline since 11-21 04:00Z, showing its scan from 11-21 03:00Z.");
  assert.equal(mac.error, "ssh exit 255: timed out");
  assert.equal(db.view(IDLE).counts.copies, 1);
});

test("changed lines and similarity count lines added and removed", () => {
  assert.equal(changedLines("a\nb\nc\n", "a\nb\nc\n"), 0);
  assert.equal(changedLines("a\nb\nc", "a\nx\nc"), 2);
  assert.equal(similarity("a\nb\nc\nd", "a\nb\nc\ne"), 0.75);
});
