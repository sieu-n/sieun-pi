import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { SkillsDb, SkillsRefused, SkillsStepFailed, type DiskResult, type DiskStep } from "../../server/skills-db.ts";
import { fixtureScanner, writeSkillsDbFixture, type SkillsDbFixture } from "../../server/skills-db-fixture.ts";
import { changedLines, similarity, staleCheckouts, type FactCopy } from "../../server/skills-model.ts";
import { SkillsReview } from "../../server/skills-review.ts";
import { Skills } from "../../server/skills.ts";
import type { SkillScan } from "../../web/src/lib/api/shared/skills.ts";

const REPO = resolve(import.meta.dirname, "../../../..");
const BOX = "us-metal02";
const IDLE: SkillScan = { running: false, startedAt: null, endedAt: null, error: null };

type Rig = { fixture: SkillsDbFixture; db: SkillsDb; review: SkillsReview; scan: () => void; present: (path: string) => boolean };

const macCopy = (path: string) => ({ box: "mac", path, realPath: path, linkTarget: null, exists: true, name: "deploy-notes", source: "user-dir", root: "/Users/o/.claude/skills", runtimes: ["claude"], hash: "h1", text: "x" });
const macScan = (at: string, copies: unknown[], ok = true) => ({ generatedAt: at, boxes: [{ box: "mac", scannedAt: at, ok, ...(ok ? {} : { error: "ssh exit 255" }) }], copies, usage: {} });

/** A skills DB over a fake disk, for steps a test box cannot take, such as the Mac's. */
function fakeDisk(t: { after: (fn: () => void) => void }, answer: { run: (steps: DiskStep[]) => DiskResult[]; undo: () => DiskResult[] }) {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-fake-"));
  const calls: { run: DiskStep[][]; undo: number } = { run: [], undo: 0 };
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, {
    run: async (_item, steps) => (calls.run.push(steps), answer.run(steps)),
    undo: async () => (calls.undo++, answer.undo()),
  });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.ingest(macScan("2026-11-22T00:00:00Z", [macCopy("/Users/o/.claude/skills/deploy-notes")]));
  return { db, calls };
}

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
    const paths = join(dir, "install-paths.json");
    writeFileSync(paths, JSON.stringify(db.installPaths()));
    execFileSync(scanner.command, [...scanner.args, "--install-paths", paths], { cwd: scanner.cwd, env: { ...process.env, ...scanner.env }, stdio: "ignore" });
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
  assert.equal(mac.since, "2026-11-21T04:00:00Z");
  assert.equal(mac.lastOkAt, "2026-11-21T03:00:00Z");
  assert.equal(mac.error, "ssh exit 255: timed out");
  assert.equal(db.view(IDLE).counts.copies, 1);
});

test("changed lines and similarity count lines added and removed", () => {
  assert.equal(changedLines("a\nb\nc\n", "a\nb\nc\n"), 0);
  assert.equal(changedLines("a\nb\nc", "a\nx\nc"), 2);
  assert.equal(similarity("a\nb\nc\nd", "a\nb\nc\ne"), 0.75);
});

test("install refuses a path outside the box's home, such as a metal path for the Mac", async t => {
  const { db } = fakeDisk(t, { run: () => [], undo: () => [] });
  await assert.rejects(db.install({ name: "deploy-notes", box: "mac", runtime: "claude", path: "/home/sieun/scratch/x/deploy-notes", mode: "copy" }), SkillsRefused);
  await assert.rejects(db.install({ name: "deploy-notes", box: "mac", runtime: "claude", path: "/Users/o/../etc/deploy-notes", mode: "copy" }), SkillsRefused);
  assert.equal(db.view(IDLE).counts.installs, 0);
});

test("an install whose step fails answers an error and keeps no row", async t => {
  const { fixture, db, scan } = rig(t);
  scan();
  writeFileSync(join(fixture.home, "blocker"), "a file where a folder would go\n");
  const installs = db.view(IDLE).counts.installs;
  await assert.rejects(db.install({ name: "deploy-notes", box: BOX, runtime: "codex", path: join(fixture.home, "blocker/deploy-notes") }), SkillsStepFailed);
  assert.equal(db.view(IDLE).counts.installs, installs);
  assert.equal(db.check().items.length, 0);
  assert.equal((await db.apply()).changes, 0);
});

test("undo of an install whose Mac step never took effect drops the row, and a failed undo answers an error", async t => {
  const failing = { value: false };
  const { db } = fakeDisk(t, {
    run: steps => steps.map(step => ({ box: step.box, path: step.path, state: "queued" as const, note: "Waits for the Mac." })),
    undo: () => [{ box: "mac", path: "/Users/o/.codex/skills/deploy-notes", state: failing.value ? "failed" as const : "undone" as const, note: failing.value ? "ssh exit 3" : null }],
  });
  const first = await db.install({ name: "deploy-notes", box: "mac", runtime: "codex", mode: "copy" });
  assert.equal(first.apply?.steps[0]?.result, "queued");
  failing.value = true;
  await assert.rejects(db.undo({ moveId: first.move.id }), SkillsStepFailed);
  assert.equal(db.moves().find(m => m.id === first.move.id)?.undoneAt, null, "a failed undo leaves the move open");
  assert.equal(db.view(IDLE).counts.installs, 1);
  failing.value = false;
  const undone = await db.undo({ moveId: first.move.id });
  assert.ok(undone.move.undoneAt);
  assert.equal(db.view(IDLE).counts.installs, 0);
});

test("an install outside every scanned root stays found after a rescan, and remove deletes its link", async t => {
  const { fixture, db, scan, present } = rig(t);
  scan();
  const path = join(fixture.home, "elsewhere/deploy-notes");
  const installed = await db.install({ name: "deploy-notes", box: BOX, runtime: "codex", path });
  const id = installed.apply!.steps[0]!.installId;
  assert.ok(present(path));
  const row = () => db.view(IDLE).skills.flatMap(k => k.copies).find(c => c.path === path);
  assert.deepEqual(row()?.loadedBy, [], "no runtime reads a folder outside its own skill folders");
  assert.deepEqual(db.view(IDLE).skills.flatMap(k => k.installs).find(i => i.id === id)?.runtimes, []);
  scan();
  assert.deepEqual(row()?.loadedBy, [], "the scan agrees after a rescan");
  assert.equal(db.check().items.length, 0, JSON.stringify(db.check().items));
  assert.equal((await db.apply()).changes, 0);
  await db.remove({ target: id });
  assert.ok(!present(path), "remove deleted the link on disk");
  scan();
  assert.equal(db.check().items.length, 0);
});

test("remove of an install whose path is gone runs a delete that ends as done, and drops the row", async t => {
  const { fixture, db, scan, present } = rig(t);
  scan();
  const path = join(fixture.home, "elsewhere/deploy-notes");
  const installed = await db.install({ name: "deploy-notes", box: BOX, runtime: "codex", path });
  const id = installed.apply!.steps[0]!.installId;
  rmSync(path);
  scan();
  assert.deepEqual(db.check().items.map(i => i.kind), ["missing"]);
  const removed = await db.remove({ target: id });
  assert.equal(removed.apply?.steps[0]?.result, "done");
  assert.ok(!present(path));
  assert.equal(db.check().items.length, 0);
});

test("a link that prime-sync moved to a newer runtime release reads ok, and a later apply links to the newer release", async t => {
  const release = (sha: string) => `/Users/o/.local/share/sieun-pi-runtime/releases/${sha}/skills/wiki`;
  const link = { ...macCopy("/Users/o/.prime/agent/skills/wiki"), name: "wiki", root: "/Users/o/.prime/agent/skills", source: "prime-links", runtimes: ["prime"] };
  const disk = (sha: string, linked = true) => [
    macCopy("/Users/o/.claude/skills/deploy-notes"),
    { ...macCopy(release(sha)), name: "wiki", root: dirname(release(sha)), source: "sieun-pi-runtime", runtimes: [] },
    ...(linked ? [{ ...link, realPath: release(sha), linkTarget: release(sha) }] : []),
  ];
  const placed: DiskStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), "skills-db-link-"));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, {
    run: async (_item, steps) => (placed.push(...steps), steps.map(step => ({ box: step.box, path: step.path, state: "applied" as const, note: null }))),
    undo: async () => [],
  });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.ingest(macScan("2026-11-22T00:00:00Z", disk("aaa")));
  db.ingest(macScan("2026-11-22T01:00:00Z", disk("bbb")));
  assert.equal(db.check().items.length, 0, JSON.stringify(db.check().items));
  db.ingest(macScan("2026-11-22T02:00:00Z", disk("bbb", false)));
  assert.deepEqual(db.check().items.map(i => i.kind), ["missing"]);
  await db.apply();
  assert.deepEqual(placed.map(step => step.kind === "place" ? step.from : null), [release("bbb")]);
});

test("a scan that walks more folders owns the copies it newly finds, and a later new folder is unowned again", async t => {
  const { db } = fakeDisk(t, { run: () => [], undo: () => [] });
  const clone = { ...macCopy("/Users/o/code/ws/VIR-1/.agents/skills/old-skill"), name: "old-skill", root: "/Users/o/code/ws/VIR-1/.agents/skills", source: "repo:ws/VIR-1" };
  db.ingest({ ...macScan("2026-11-22T01:00:00Z", [macCopy("/Users/o/.claude/skills/deploy-notes"), clone]), coverage: 2 });
  assert.equal(db.check().items.length, 0, JSON.stringify(db.check().items));
  const later = { ...clone, path: "/Users/o/code/ws/VIR-1/.agents/skills/new-skill", realPath: "/Users/o/code/ws/VIR-1/.agents/skills/new-skill", name: "new-skill" };
  db.ingest({ ...macScan("2026-11-22T02:00:00Z", [macCopy("/Users/o/.claude/skills/deploy-notes"), clone, later]), coverage: 2 });
  assert.deepEqual(db.check().items.map(i => i.kind), ["unowned"]);
});

test("a Python skill reads imported, the WRITING_SKILL reads inlined in sw threads, and a Prime duty sees what a Prime chat sees", async t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-sees-"));
  const fixture = writeSkillsDbFixture(join(dir, "tree"), { reviewDir: join(dir, "review"), box: BOX });
  const tool = join(fixture.home, "src/tools/.agents/skills/py-tool");
  mkdirSync(join(tool, "src/py_tool"), { recursive: true });
  writeFileSync(join(tool, "SKILL.md"), "---\nname: py-tool\ndescription: Use when a test needs a Python skill.\n---\n\n# Py tool\n");
  writeFileSync(join(tool, "pyproject.toml"), "[project]\nname = \"py-tool\"\n");
  writeFileSync(join(tool, "src/py_tool/__init__.py"), "");
  symlinkSync(tool, join(fixture.home, ".prime/agent/skills/py-tool"));
  const brief = join(dir, "chat-brief.ts");
  writeFileSync(brief, 'export const WRITING_SKILL = "board-rules";\n');
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: fixture.home, piHostPrompt: brief }, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const scanner = fixtureScanner(fixture, REPO);
  execFileSync(scanner.command, scanner.args, { cwd: scanner.cwd, env: { ...process.env, ...scanner.env }, stdio: "ignore" });
  db.ingest(JSON.parse(readFileSync(fixture.inventory, "utf8")));
  const sight = (name: string) => Object.fromEntries(db.view(IDLE).skills.find(k => k.name === name)!.sees.map(x => [x.kind, x.how]));
  assert.equal(sight("py-tool")["prime-chat"], "imported");
  assert.equal(sight("py-tool")["prime-duty"], "imported");
  assert.equal(sight("py-tool")["sw-work"], "imported");
  assert.equal(sight("board-rules")["sw-comm"], "inlined");
  assert.equal(sight("board-rules")["prime-chat"], "listed");
  assert.equal(sight("deploy-notes")["prime-duty"], sight("deploy-notes")["prime-chat"]);
});

test("a checkout that fetched this week is judged by its own origin, and one with no fresh origin by the newest clone of its repo", () => {
  const now = Date.parse("2026-11-22T04:00:00Z");
  const clone = (box: string, headAt: string, upstream: { at: string; behind: number; fetchedAt: string } | null) => ({
    box, path: `/${box}/slack-green/.agents/skills/x`,
    checkout: { root: `/${box}/slack-green`, remote: "git@github.com:o/slack-green.git", branch: "main", headAt, upstreamAt: upstream?.at ?? null, behind: upstream?.behind ?? 0, fetchedAt: upstream?.fetchedAt ?? null, tracked: true },
  }) as unknown as FactCopy;
  const current = clone("metal", "2026-11-10T00:00:00Z", { at: "2026-11-10T00:00:00Z", behind: 0, fetchedAt: "2026-11-22T03:00:00Z" });
  const behind = clone("metal2", "2026-11-12T00:00:00Z", { at: "2026-11-21T00:00:00Z", behind: 120, fetchedAt: "2026-11-21T23:00:00Z" });
  const newer = clone("mac", "2026-11-21T00:00:00Z", { at: "2026-11-21T00:00:00Z", behind: 0, fetchedAt: "2026-11-21T00:00:00Z" });
  const unfetched = clone("mac2", "2026-06-01T00:00:00Z", { at: "2026-06-01T00:00:00Z", behind: 0, fetchedAt: "2026-06-01T00:00:00Z" });
  const detached = clone("mac3", "2026-09-02T00:00:00Z", null);
  const stale = staleCheckouts([current, behind, newer, unfetched, detached], now);
  assert.equal(stale.has(current), false, "current with its own fresh origin, though another box's clone is 11 days newer");
  assert.equal(stale.has(behind), true, "9 days behind its own origin head");
  assert.equal(stale.has(newer), false);
  assert.equal(stale.has(unfetched), true, "last fetched in June, so judged by the newest clone");
  assert.equal(stale.has(detached), true, "no upstream, so judged by the newest clone");
});

test("a name two skills share credits each thread kind's use to the copy that kind loads, so no use counts twice", t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-credit-"));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const at = "2026-11-22T04:00:00Z";
  const bundled = "/home/x/.local/share/prime-agent/releases/0.9.8/skills/agent-message";
  const forked = "/home/x/src/sieun-pi/packages/pi-rlm/skills/agent-message";
  const copy = (path: string, source: string, hash: string) => ({ box: BOX, path, realPath: path, linkTarget: null, exists: true, name: "agent-message", source, root: dirname(path), runtimes: [], hash, text: "x" });
  db.ingest({
    generatedAt: at, boxes: [{ box: BOX, scannedAt: at, ok: true }], usageCounted: true,
    copies: [copy(bundled, "prime-release", "h1"), copy(forked, "sieun-pi-package", "h2")],
    usage: { "agent-message": { uses30d: 45, sessions30d: 30, lastUse: at, byKind: { "prime-chat": { uses: 20, sessions: 10 }, "sw-work": { uses: 15, sessions: 12 }, claude: { uses: 10, sessions: 8 } } } },
  });
  const rows = db.view(IDLE).skills.filter(k => k.name === "agent-message");
  assert.equal(rows.length, 2);
  const of = (path: string) => rows.find(k => k.copies.some(c => c.path === path))!.use;
  assert.equal(of(bundled).uses, 45, "every kind loads the bundled copy, and claude, which loads neither, goes to it too");
  assert.equal(of(forked).uses, 0);
  assert.equal(rows.reduce((n, k) => n + k.use.uses, 0), 45);
});

test("a SKILL.md read that names a path credits the copy at that path, and only the rest goes by sight", t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-path-"));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const at = "2026-11-22T04:00:00Z";
  const repo = (name: string) => `/home/x/src/${name}`;
  const skill = (name: string) => `${repo(name)}/.agents/skills/workflows/frontend-implementation`;
  const copy = (name: string, text: string) => ({
    box: BOX, path: skill(name), realPath: skill(name), linkTarget: null, exists: true, name: "frontend-implementation", source: `repo:${name}`, root: dirname(skill(name)),
    runtimes: ["claude", "codex"], hash: `h-${name}`, text,
    checkout: { root: repo(name), remote: `git@github.com:o/${name}.git`, branch: "main", headAt: at, upstreamAt: at, behind: 0, fetchedAt: at, tracked: true },
  });
  db.ingest({
    generatedAt: at, usageCounted: true, boxes: [{ box: BOX, scannedAt: at, ok: true, settings: { repos: { [repo("auto-sns-agent")]: ["!../../.agents/skills/**"] } } }],
    copies: [copy("auto-sns-agent", "one guide"), copy("slack-green", "another guide")],
    usage: {
      "frontend-implementation": {
        uses30d: 12, sessions30d: 9, lastUse: at,
        byKind: { "prime-chat": { uses: 10, sessions: 7 }, "prime-job": { uses: 2, sessions: 2 } },
        byPath: [
          { box: BOX, path: `${skill("auto-sns-agent")}/SKILL.md`, kind: "prime-chat", uses: 6, sessions: 4 },
          { box: BOX, path: "~/src/auto-sns-agent/.agents/skills/workflows/frontend-implementation/SKILL.md", kind: "prime-chat", uses: 1, sessions: 1 },
          { box: BOX, path: ".agents/skills/nowhere/frontend-implementation/SKILL.md", kind: "prime-job", uses: 1, sessions: 1 },
          { box: BOX, path: `${repo("auto-sns-agent")}/.agents/skills/frontend-implementation/SKILL.md`, kind: "prime-chat", uses: 2, sessions: 1 },
        ],
      },
    },
  });
  const rows = db.view(IDLE).skills.filter(k => k.name === "frontend-implementation");
  const of = (name: string) => rows.find(k => k.id.startsWith(`git:${name}/`))!.use.uses;
  assert.equal(of("auto-sns-agent"), 9, "6 absolute and 1 ~/ reads of its path and 2 read-skill.mjs reads under its checkout, though its settings hide it");
  assert.equal(of("slack-green"), 3, "the 1 prime-chat read with no path and the 2 prime-job uses go by sight");
  assert.equal(rows.reduce((n, k) => n + k.use.uses, 0), 12);
});

test("a box whose scan fails keeps its last use counts in the totals, and its next good scan replaces them", t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-usebox-"));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const copy = { box: BOX, path: "/home/x/.claude/skills/notes", realPath: "/home/x/.claude/skills/notes", linkTarget: null, exists: true, name: "notes", source: "user-dir", root: "/home/x/.claude/skills", runtimes: ["claude"], hash: "h1", text: "x" };
  const use = (uses: number, at: string) => ({ notes: { uses30d: uses, sessions30d: uses, lastUse: at, byKind: { claude: { uses, sessions: uses } }, byPath: [] } });
  const scan = (at: string, mac: boolean, metalUses: number, macUses: number) => db.ingest({
    generatedAt: at, usageCounted: true, copies: [copy],
    boxes: [{ box: BOX, scannedAt: at, ok: true }, { box: "mac", scannedAt: at, ok: mac, ...(mac ? {} : { error: "ssh exit 255" }) }],
    usage: {}, usageByBox: { [BOX]: use(metalUses, at), ...(mac ? { mac: use(macUses, at) } : {}) },
  });
  const uses = () => db.view(IDLE).skills.find(k => k.name === "notes")!.use;
  scan("2026-11-22T05:00:00Z", true, 5, 3);
  assert.equal(uses().uses, 8);
  scan("2026-11-22T06:00:00Z", false, 6, 0);
  assert.equal(uses().uses, 9, "metal's new 6 plus the Mac's last 3");
  assert.equal(uses().byKind.claude?.uses, 9);
  scan("2026-11-22T07:00:00Z", true, 6, 1);
  assert.equal(uses().uses, 7);
});

test("duplicates: a pair is flagged once on the copy that is not canonical, two upstreams only get a note, and one folder per box is never extra", t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-dup-"));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const at = "2026-11-22T04:00:00Z";
  const body = (topic: string, n = -1) => Array.from({ length: 40 }, (_, i) => `${i + 1}. ${topic} step ${i + 1} of ${topic}${i === n ? " changed" : ""}.`).join("\n");
  const hash = (text: string) => `h${[...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)}`;
  const copy = (box: string, path: string, name: string, source: string, text: string, root?: string) => ({
    box, path, realPath: path, linkTarget: null, exists: true, name, source, root: dirname(path), runtimes: [], hash: hash(text), text, mtime: at,
    ...(root ? { checkout: { root, remote: "git@github.com:o/notes-repo.git", branch: "main", headAt: at, upstreamAt: at, behind: 0, fetchedAt: at, tracked: true } } : {}),
  });
  const bundle = "/home/x/.local/share/prime-agent/releases/0.9.8/skills/edit";
  const vendored = "/home/x/src/sieun-pi/packages/pi-rlm/skills/edit";
  const control = (name: string) => `/home/x/.codex/plugins/cache/openai/${name}/1.0/skills/${name}`;
  db.ingest({
    generatedAt: at, usageCounted: false, usage: {},
    boxes: [{ box: BOX, scannedAt: at, ok: true }, { box: "mac", scannedAt: at, ok: true }],
    copies: [
      copy(BOX, bundle, "edit", "prime-release", body("edit")),
      copy("mac", "/Users/o/.local/share/prime-agent/releases/0.9.8/skills/edit", "edit", "prime-release", body("edit")),
      copy(BOX, vendored, "edit", "sieun-pi-package", body("edit")),
      copy(BOX, control("control-chrome"), "control-chrome", "codex-plugin", body("chrome")),
      copy(BOX, control("control-in-app-browser"), "control-in-app-browser", "codex-plugin", body("chrome", 3)),
      copy(BOX, control("control-chrome").replace("/1.0/", "/latest/"), "control-chrome", "codex-plugin", body("chrome")),
      copy("mac", "/Users/o/src/notes-repo/.agents/skills/notes", "notes", "repo:notes-repo", body("notes"), "/Users/o/src/notes-repo"),
      copy("mac", "/Users/o/code/notes-repo/.agents/skills/notes", "notes", "repo:notes-repo", body("notes"), "/Users/o/code/notes-repo"),
    ],
  });
  const view = db.view(IDLE);
  const row = (pred: (path: string) => boolean) => view.skills.find(k => k.copies.some(c => pred(c.path)))!;
  const rules = (pred: (path: string) => boolean) => row(pred).verdicts.map(v => v.rule).filter(rule => rule !== "bloated");
  assert.deepEqual(rules(p => p === bundle), [], "the upstream bundle is canonical and carries nothing");
  assert.equal(row(p => p === bundle).extraCopies.length, 0, "one Prime release folder per box is not extra");
  assert.deepEqual(rules(p => p === vendored), ["duplicate"]);
  assert.match(row(p => p === vendored).verdicts.find(v => v.rule === "duplicate")!.detail, /same text as upstream:prime-agent\/edit/);
  const browser = [...rules(p => p === control("control-chrome")), ...rules(p => p === control("control-in-app-browser"))];
  assert.deepEqual(browser, ["upstream-match", "upstream-match"], "the plugin cache's latest folder and the second plugin are notes");
  const notes = row(p => p.endsWith("/notes"));
  assert.deepEqual(notes.extraCopies.map(x => x.why), ["same-text"]);
  assert.ok(notes.verdicts.some(v => v.rule === "duplicate" && v.copyId === notes.extraCopies[0]!.copyId));
  assert.equal(view.counts.duplicated, 2, "the vendored edit and the second notes folder, not the bundle or the two plugins");
});

test("the review runs a skills DB delete of a path that is gone as a no-op, and undoes a step that failed as nothing to put back", async t => {
  const { fixture, review } = rig(t);
  const steps = review.diskSteps(fixture.setName);
  const gone = await steps.run("sw:mv_gone", [{ kind: "delete", box: BOX, path: join(fixture.home, ".claude/skills/never-there"), name: "never-there" }]);
  assert.equal(gone[0]!.state, "applied");
  assert.equal((await steps.undo("sw:mv_gone"))[0]!.state, "undone");
  writeFileSync(join(fixture.home, "blocker"), "x\n");
  const failed = await steps.run("sw:mv_fail", [{ kind: "place", box: BOX, path: join(fixture.home, "blocker/x"), name: "x", mode: "link", from: "/nowhere" }]);
  assert.equal(failed[0]!.state, "failed");
  assert.equal((await steps.undo("sw:mv_fail"))[0]!.state, "undone");
  assert.equal((await review.report(fixture.setName)).items.filter(item => item.id.startsWith("sw:")).length, 0, "the review list hides skills DB items");
});
