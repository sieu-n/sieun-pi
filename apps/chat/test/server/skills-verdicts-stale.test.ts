import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SkillsDb } from "../../server/skills-db.ts";
import type { SkillScan } from "../../web/src/lib/api/shared/skills.ts";

const BOX = "us-metal02";
const IDLE: SkillScan = { running: false, startedAt: null, endedAt: null, error: null };

test("rules: a skill only old clones hold is never paired as a duplicate, near-duplicate or name clash; the stale-clone rule speaks for it", t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-db-stale-pairs-"));
  const db = new SkillsDb({ file: join(dir, "chat.sqlite"), box: BOX, home: "/home/x", piHostPrompt: null }, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const body = (topic: string) => Array.from({ length: 30 }, (_, i) => `${i + 1}. ${topic} step ${i + 1} of ${topic}.`).join("\n");
  const near = (topic: string) => body(topic).replace("30. ", "30. Also ");
  const checkout = (repo: string, root: string, old: boolean) => ({
    root, remote: `git@github.com:o/${repo}.git`, branch: "main", tracked: true, dirty: old ? 2 : 0, unpushed: 0,
    headAt: old ? "2026-09-01T00:00:00Z" : now, upstreamAt: now, fetchedAt: now, behind: old ? 50 : 0,
  });
  const copy = (path: string, name: string, text: string, extra: Record<string, unknown> = {}) => ({
    box: BOX, path, realPath: path, linkTarget: null, exists: true, name, source: "user-dir", root: dirname(path), runtimes: ["claude"],
    hash: `h-${text.length}-${text.slice(0, 12)}-${text.slice(-12)}`, text, mtime: now, ...extra,
  });
  const inRepo = (repo: string, root: string, rel: string, name: string, text: string, old: boolean) =>
    copy(`${root}/${rel}`, name, text, { source: `repo:${repo}`, checkout: checkout(repo, root, old) });
  db.ingest({
    generatedAt: now, usageCounted: false, usage: {},
    boxes: [{ box: BOX, scannedAt: now, ok: true }],
    copies: [
      inRepo("asa", "/home/x/code/asa-old", ".agents/skills/symphony/commit", "commit", body("commit"), true),
      inRepo("sg", "/home/x/code/sg-old", ".agents/skills/symphony/commit", "commit", body("commit"), true),
      inRepo("asa", "/home/x/code/asa-old", ".agents/skills/symphony/push", "push", near("push"), true),
      inRepo("sg", "/home/x/src/sg", ".agents/skills/symphony/push", "push", body("push"), false),
      inRepo("asa", "/home/x/code/asa-old", ".agents/skills/repo/notes", "notes", body("old notes"), true),
      inRepo("sg", "/home/x/src/sg", ".agents/skills/repo/notes", "notes", body("live notes"), false),
      inRepo("sg", "/home/x/src/sg", ".agents/skills/ship", "ship", body("ship"), false),
      copy("/home/x/.claude/skills/ship-again", "ship", body("ship")),
    ],
  });
  const view = db.view(IDLE);
  const paired = new Set(["duplicate", "near-duplicate", "name-clash", "upstream-match", "stale-clone"]);
  const rules = (id: string) => view.skills.find(s => s.id === id)!.verdicts.filter(v => paired.has(v.rule)).map(v => `${v.rule}:${v.action}`).sort();
  assert.deepEqual(rules("git:asa/.agents/skills/symphony/commit"), ["stale-clone:note"], "same text as another old clone");
  assert.deepEqual(rules("git:sg/.agents/skills/symphony/commit"), ["stale-clone:note"]);
  assert.deepEqual(rules("git:asa/.agents/skills/symphony/push"), ["stale-clone:note"], "near the live push, but only an old clone holds it");
  assert.deepEqual(rules("git:sg/.agents/skills/symphony/push"), []);
  assert.deepEqual(rules("git:asa/.agents/skills/repo/notes"), ["stale-clone:note"], "a name shared with a live skill is no clash from an old clone");
  assert.deepEqual(rules("git:sg/.agents/skills/repo/notes"), []);
  const loose = view.skills.find(s => s.copies.some(c => c.path === "/home/x/.claude/skills/ship-again"))!;
  assert.deepEqual(loose.verdicts.filter(v => paired.has(v.rule)).map(v => `${v.rule}:${v.action}`), ["duplicate:remove"], "two live skills with the same text still pair");
});
