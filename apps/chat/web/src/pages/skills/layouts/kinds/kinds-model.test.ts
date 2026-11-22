import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillCopy, SkillEntry, SkillsView } from "../../../../lib/api/shared/skills.ts";
import { cellFor, driftOf, installDrift, families, kindColumns, problemsOf, rowsFor, shortPath, sizeOf } from "./kinds-model.ts";

const copy = (over: Partial<SkillCopy>): SkillCopy => ({
  id: "us-metal02:/s/board", box: "us-metal02", path: "/s/board", role: "source", installId: null, link: null, realPath: "/s/board", exists: true, hash: "h", lines: 70,
  bytes: 4000, folderBytes: 4000, files: 1, mtime: null, loadedBy: ["prime", "pi-host"], changedLines: 0, checkout: null, ...over,
});

const entry = (over: Partial<SkillEntry>): SkillEntry => ({
  id: "git:sieun-pi/skills/board", name: "board", description: "Read a chat's board", owner: { kind: "owner" },
  source: { kind: "git", repo: "sieun-pi", path: "skills/board" }, installs: [], copies: [copy({})], size: { lines: 70, bytes: 4000, ratio: 1 },
  verdicts: [], use: { uses: 0, sessions: 0, lastUse: null, byKind: {} }, preimported: false, sees: [], ...over,
});

const view = (skills: SkillEntry[]): SkillsView => ({
  generatedAt: null, seededAt: null,
  counts: { skills: skills.length, copies: 0, installs: 0, duplicated: 0, outdated: 0, bloated: 0, neverUsed: skills.filter(s => s.use.uses === 0).length, drift: 0 },
  thresholds: { medianBytes: 4208, medianLines: 75, bloatBytes: 12624, nearDuplicate: 0.5, staleCheckoutDays: 30, source: "test" },
  boxes: [], skills, unowned: [], scan: { running: false, startedAt: null, endedAt: null, error: null },
});

test("rows sort by 30-day use, most used first and never used last", () => {
  const v = view([
    entry({ id: "a", name: "alpha" }),
    entry({ id: "b", name: "beta", use: { uses: 5, sessions: 2, lastUse: null, byKind: {} } }),
    entry({ id: "c", name: "gamma", use: { uses: 900, sessions: 40, lastUse: null, byKind: {} } }),
  ]);
  assert.deepEqual(rowsFor(v, "all", "").map(r => r.entry.name), ["gamma", "beta", "alpha"]);
  assert.deepEqual(rowsFor(v, "unused", "").map(r => r.entry.name), ["alpha"]);
  assert.deepEqual(rowsFor(v, "all", "BET").map(r => r.entry.name), ["beta"]);
});

test("each problem comes from its verdict rules", () => {
  const e = entry({
    use: { uses: 3, sessions: 1, lastUse: null, byKind: {} },
    verdicts: [
      { rule: "near-duplicate", action: "remove", detail: "", copyId: null, other: null },
      { rule: "stale-clone", action: "remove", detail: "", copyId: null, other: null },
    ],
  });
  assert.deepEqual(problemsOf(e, true), ["duplicated", "outdated"]);
  assert.deepEqual(problemsOf(entry({}), true), ["unused"]);
  assert.deepEqual(problemsOf(entry({}), false), []);
  assert.deepEqual(problemsOf(entry({ source: { kind: "harness", entryKind: "memory", entryId: "m1" } }), true), []);
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
  assert.equal(cols.find(c => c.kind === "sw-work")?.tokens, 2500);
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
