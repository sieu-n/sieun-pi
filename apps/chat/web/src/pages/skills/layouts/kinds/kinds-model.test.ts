import assert from "node:assert/strict";
import { test } from "node:test";
import { USEFUL_DEFINITION, usefulOf, type SkillCopy, type SkillEntry, type SkillsView } from "../../../../lib/api/shared/skills.ts";
import { cellFor, copiesTitle, driftOf, extraLabel, installDrift, pathUsesLabel, families, kindColumns, problemsOf, rowsFor, shortPath, sizeOf, usesLabel } from "./kinds-model.ts";

const copy = (over: Partial<SkillCopy>): SkillCopy => ({
  id: "us-metal02:/s/board", box: "us-metal02", path: "/s/board", role: "source", installId: null, link: null, realPath: "/s/board", exists: true, hash: "h", lines: 70,
  bytes: 4000, folderBytes: 4000, files: 1, mtime: null, loadedBy: ["prime", "pi-host"], changedLines: 0, checkout: null, ...over,
});

const entry = (over: Partial<SkillEntry>): SkillEntry => withUseful({
  id: "git:sieun-pi/skills/board", name: "board", description: "Read a chat's board", owner: { kind: "owner" },
  source: { kind: "git", repo: "sieun-pi", path: "skills/board" }, installs: [], copies: [copy({})], size: { lines: 70, bytes: 4000, ratio: 1 },
  verdicts: [], use: { uses: 0, sessions: 0, lastUse: null, nameUses: 0, byKind: {} }, preimported: false, sees: [], extraCopies: [], ...over,
});

function withUseful(e: Omit<SkillEntry, "useful"> & Partial<Pick<SkillEntry, "useful">>): SkillEntry {
  return { ...e, useful: usefulOf(e) };
}

const unused = { rule: "unused", action: "review-description", detail: "", copyId: null, other: null } as const;

const view = (skills: SkillEntry[]): SkillsView => ({
  generatedAt: null, seededAt: null,
  counts: { skills: skills.length, copies: 0, installs: 0, duplicated: 0, outdated: 0, bloated: 0, neverUsed: skills.filter(s => s.use.uses === 0).length, oldClones: 0, useful: 0, drift: 0 },
  usefulDefinition: USEFUL_DEFINITION,
  thresholds: { medianBytes: 4208, medianLines: 75, bloatBytes: 12624, nearDuplicate: 0.5, staleCheckoutDays: 30, source: "test" },
  boxes: [], skills, unowned: [], scan: { running: false, startedAt: null, endedAt: null, error: null },
});

test("rows sort by 30-day use, most used first and never used last", () => {
  const v = view([
    entry({ id: "a", name: "alpha", verdicts: [unused] }),
    entry({ id: "b", name: "beta", use: { uses: 5, sessions: 2, lastUse: null, nameUses: 5, byKind: {} } }),
    entry({ id: "c", name: "gamma", use: { uses: 900, sessions: 40, lastUse: null, nameUses: 900, byKind: {} } }),
  ]);
  assert.deepEqual(rowsFor(v, "all", "").map(r => r.entry.name), ["gamma", "beta", "alpha"]);
  assert.deepEqual(rowsFor(v, "unused", "").map(r => r.entry.name), ["alpha"]);
  assert.deepEqual(rowsFor(v, "all", "BET").map(r => r.entry.name), ["beta"]);
});

test("each problem comes from its verdict rules, an old clone is no outdated skill, and never used reads the unused verdict", () => {
  const stale = { root: "/Users/o/code/old", branch: "main", headAt: "2026-09-01T00:00:00Z", stale: true };
  const e = entry({
    use: { uses: 3, sessions: 1, lastUse: null, nameUses: 3, byKind: {} },
    copies: [copy({}), copy({ id: "mac:/Users/o/code/old/board", box: "mac", path: "/Users/o/code/old/board", checkout: stale })],
    verdicts: [
      { rule: "near-duplicate", action: "remove", detail: "", copyId: null, other: null },
      { rule: "stale-clone", action: "note", detail: "", copyId: "mac:/Users/o/code/old/board", other: null },
      { rule: "outdated", action: "note", detail: "", copyId: "us-metal02:/s/board", other: null },
    ],
  });
  assert.deepEqual(problemsOf(e), ["duplicated", "outdated"]);
  assert.deepEqual(problemsOf(entry({ verdicts: [{ rule: "stale-clone", action: "note", detail: "", copyId: null, other: null }] })), [], "stale-clone alone is not outdated");
  assert.deepEqual(problemsOf(entry({ verdicts: [unused] })), ["unused"]);
  assert.deepEqual(problemsOf(entry({})), [], "no unused verdict: its name was used through another copy, or use was not counted");
  const old = entry({ copies: [copy({ checkout: stale })], verdicts: [unused, { rule: "bloated", action: "note", detail: "", copyId: null, other: null }] });
  assert.deepEqual(problemsOf(old), ["oldClone"], "a skill only old clones hold is an old clone and nothing else");
});

test("a skill whose name another copy used reads its name's uses, not never used", () => {
  const vendored = entry({ use: { uses: 0, sessions: 0, lastUse: null, nameUses: 12_467, byKind: {} } });
  assert.deepEqual(problemsOf(vendored), []);
  assert.equal(usesLabel(vendored, false), "12,467 uses of its name went to another skill of the same name over 30 days");
});

test("a column counts the skills its kind lists and estimates their tokens", () => {
  const v = view([
    entry({ id: "a", name: "board", sees: [{ kind: "sw-comm", how: "listed", copyId: "us-metal02:/s/board" }] }),
    entry({ id: "b", name: "wiki", sees: [{ kind: "sw-comm", how: "imported", copyId: "x" }, { kind: "prime-chat", how: "cwd", repo: "/r/slack-green", copyId: "x" }] }),
    entry({ id: "c", name: "secret", sees: [{ kind: "sw-comm", how: "hidden", why: "disable-model-invocation" }] }),
    entry({ id: "d", name: "unslop", size: { lines: 120, bytes: 10_000, ratio: 2.4 }, sees: [{ kind: "sw-work", how: "inlined", copyId: "x" }] }),
  ]);
  const cols = kindColumns(v);
  const comm = cols.find(c => c.kind === "sw-comm");
  assert.equal(comm?.listed, 2);
  assert.equal(comm?.imported, 1);
  assert.ok((comm?.tokens ?? 0) > 20);
  assert.ok((cols.find(c => c.kind === "sw-work")?.tokens ?? 0) > 2500);
  assert.equal(cols.find(c => c.kind === "sw-work")?.inlined, 1);
  assert.deepEqual(cols.find(c => c.kind === "prime-chat")?.cwd, [{ repo: "/r/slack-green", count: 1 }]);
  assert.equal(families().reduce((n, f) => n + f.span, 0), cols.length);
});

test("a cell says how the kind sees the skill, with the reason for hidden", () => {
  const e = entry({ sees: [{ kind: "prime-job", how: "hidden", why: "Prime lists it only at depth 0" }, { kind: "sw-work", how: "imported", copyId: "us-metal02:/s/board" }] });
  assert.deepEqual(cellFor(e, "prime-job"), { tone: "hidden", label: "hidden", title: "Prime lists it only at depth 0" });
  assert.equal(cellFor(e, "sw-work").label, "pre-imported");
  assert.equal(cellFor(e, "codex").tone, "hidden");
});

test("drift reads the install state first, then the line diff and the clone age", () => {
  assert.equal(driftOf(copy({ role: "checkout", changedLines: 12 }), null).label, "12 lines differ");
  assert.equal(driftOf(copy({ role: "checkout", changedLines: 0, checkout: { root: "/c", branch: null, headAt: "2026-04-21T00:00:00Z", stale: true } }), null).label, "old clone, same text");
  assert.equal(driftOf(copy({ exists: false, link: "/gone" }), null).label, "broken link");
  const install = { id: "i1", box: "mac", path: "/p", mode: "copy" as const, runtimes: [], agent: null, state: { kind: "behind" as const, changedLines: 74 } };
  assert.equal(driftOf(copy({ role: "install", installId: "i1" }), install).label, "behind source, 74 lines");
});

test("size compares bytes with the median and flags bloat", () => {
  const t = view([]).thresholds;
  assert.deepEqual(sizeOf(94583, 272, t)?.ratio, "22× median");
  assert.equal(sizeOf(94583, 272, t)?.bloated, true);
  assert.equal(sizeOf(4208, 75, t)?.ratio, "1.0× median");
  assert.equal(sizeOf(null, null, t), null);
});

test("a path under a home folder reads with ~", () => {
  assert.equal(shortPath("/home/sieun/.prime/agent/skills/board"), "~/.prime/agent/skills/board");
  assert.equal(shortPath("/Users/sieunpark/code/x"), "~/code/x");
  assert.equal(shortPath("/opt/skills/x"), "/opt/skills/x");
});

test("an install with no folder on disk says why", () => {
  const install = { id: "i2", box: "mac", path: "/p", mode: "link" as const, runtimes: [], agent: null, state: { kind: "missing" as const } };
  assert.equal(installDrift(install).label, "install missing");
  assert.equal(installDrift({ ...install, state: { kind: "ok" } }).label, "not scanned yet");
});

test("a hidden kind that still used the skill reads as opened by path", () => {
  const e = entry({
    sees: [{ kind: "prime-subagent", how: "hidden", why: "no folder this kind reads holds it" }, { kind: "sw-work", how: "listed", copyId: "x" }],
    use: { uses: 10, sessions: 4, lastUse: null, nameUses: 10, byKind: { "prime-subagent": { uses: 7, sessions: 3 }, "sw-work": { uses: 3, sessions: 1 } } },
  });
  assert.equal(cellFor(e, "prime-subagent").label, "by path");
  assert.match(cellFor(e, "prime-subagent").title, /opened it by its path 7 times/);
  assert.equal(cellFor(e, "prime-job").label, "hidden");
  assert.equal(pathUsesLabel(e), "7 of its uses came from threads that do not list it and opened it by its path: Prime subagent.");
});

test("an extra copy names the folder kept in its place", () => {
  const e = entry({
    copies: [copy({}), copy({ id: "mac:/Users/x/code/old/board", box: "mac", path: "/Users/x/code/old/board", role: "checkout" })],
    extraCopies: [{ copyId: "mac:/Users/x/code/old/board", keptId: "us-metal02:/s/board", why: "stale-clone" }],
  });
  assert.equal(extraLabel(e, "mac:/Users/x/code/old/board"), "extra, old clone of /s/board");
  assert.equal(extraLabel(e, "us-metal02:/s/board"), null);
  assert.match(copiesTitle(e), /1 is an extra folder/);
});
