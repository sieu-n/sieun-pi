import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillCopy, SkillEntry, SkillThresholds, SkillVerdictRow } from "../../../../lib/api/shared/skills.ts";
import { drift, healthy, problemGroups, problemsOf, sight, sizeText, splitPath, weakDescription } from "./model.ts";

const limits: SkillThresholds = { medianBytes: 4000, medianLines: 75, bloatBytes: 12000, nearDuplicate: 0.8, staleCheckoutDays: 30, source: "test" };

const copy = (over: Partial<SkillCopy>): SkillCopy => ({
  id: "m:/a/SKILL.md", box: "m", path: "/a/SKILL.md", realPath: "/a/SKILL.md", role: "source", installId: null, link: null, exists: true, hash: "h", lines: 10,
  bytes: 400, folderBytes: 400, files: 1, mtime: null, loadedBy: ["prime"], changedLines: 0, checkout: null, ...over,
});

const verdict = (over: Partial<SkillVerdictRow>): SkillVerdictRow => ({ rule: "duplicate", action: "remove", detail: "", copyId: null, other: null, ...over });

const skill = (name: string, over: Partial<SkillEntry> = {}): SkillEntry => ({
  id: `git:sieun-pi/skills/${name}`, name, description: `${name} skill`, owner: { kind: "owner" }, source: { kind: "git", repo: "sieun-pi", path: `skills/${name}` },
  installs: [], copies: [copy({ id: `m:/${name}`, path: `/${name}` })], size: { lines: 10, bytes: 400, ratio: 0.1 }, verdicts: [],
  use: { uses: 0, sessions: 0, lastUse: null, byKind: {} }, preimported: false, sees: [], ...over,
});

test("a skill with two problems sits in both groups, each worst first", () => {
  const twoCopies = skill("two", { verdicts: [verdict({ copyId: "m:/x" }), verdict({ copyId: "m:/y" })] });
  const oneCopy = skill("one", { verdicts: [verdict({ copyId: "m:/z" }), verdict({ rule: "bloated", action: "note" })], size: { lines: 900, bytes: 90000, ratio: 22.5 } });
  const bigger = skill("bigger", { verdicts: [verdict({ rule: "bloated", action: "note" })], size: { lines: 2000, bytes: 120000, ratio: 30 } });
  const groups = problemGroups([oneCopy, twoCopies, bigger], null, "");
  assert.deepEqual(groups.map(g => [g.kind, g.skills.map(s => s.name)]), [["duplicated", ["two", "one"]], ["bloated", ["bigger", "one"]]]);
  assert.deepEqual(problemsOf(oneCopy), ["duplicated", "bloated"]);
  assert.deepEqual(problemGroups([oneCopy, twoCopies, bigger], "bloated", "big").map(g => g.skills.map(s => s.name)), [["bigger"]]);
});

test("outdated skills order by the changed lines of their outdated copies", () => {
  const small = skill("small", { copies: [copy({ id: "a", changedLines: 3, role: "checkout" })], verdicts: [verdict({ rule: "outdated", action: "note", copyId: "a" })] });
  const large = skill("large", { copies: [copy({ id: "b", changedLines: 300, role: "checkout" })], verdicts: [verdict({ rule: "stale-clone", action: "note", copyId: "b" })] });
  assert.deepEqual(problemGroups([small, large], "outdated", "")[0]?.skills.map(s => s.name), ["large", "small"]);
});

test("healthy skills list most used first and never used last, and only our unused ones ask for a description review", () => {
  const busy = skill("busy", { use: { uses: 900, sessions: 40, lastUse: null, byKind: {} } });
  const quiet = skill("quiet", { use: { uses: 3, sessions: 1, lastUse: null, byKind: {} } });
  const never = skill("never", { verdicts: [verdict({ rule: "unused", action: "review-description" })] });
  const plugin = skill("plugin", { verdicts: [verdict({ rule: "unused", action: "note" })] });
  assert.deepEqual(healthy([never, quiet, busy, plugin], "").map(s => s.name), ["busy", "quiet", "never", "plugin"]);
  assert.equal(weakDescription(never), true);
  assert.equal(weakDescription(plugin), false);
});

test("a copy row says its drift, its size against the median and keeps the folder name when the path is cut", () => {
  assert.deepEqual(drift(copy({ role: "checkout", changedLines: 74 })), { text: "74 lines changed", changed: true });
  assert.deepEqual(drift(copy({ role: "install", changedLines: 0 })), { text: "same as source", changed: false });
  assert.equal(drift(copy({ role: "source" })).text, "source");
  assert.deepEqual(sizeText(94583, limits), { text: "95 KB, 23.6x median", ratio: 94583 / 4000, bloated: true });
  assert.deepEqual(splitPath("/home/sieun/src/sieun-pi/skills/board"), { head: "/home/sieun/src/sieun-pi/skills/", tail: "board" });
  assert.deepEqual(sight([{ kind: "sw-comm", how: "listed", copyId: "x" }, { kind: "sw-work", how: "inlined", copyId: "x" }, { kind: "prime-job", how: "hidden", why: "disable-model-invocation" }]), {
    listed: ["sw factory comm", "sw factory work (full text)"],
    hidden: [{ kind: "Prime job", why: "disable-model-invocation" }],
  });
});
