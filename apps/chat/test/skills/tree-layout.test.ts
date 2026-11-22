import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillBoxState, SkillCopy, SkillEntry, SkillThresholds, SkillTreeNode, SkillVerdictRow } from "../../web/src/lib/api/shared/skills.ts";
import {
  ancestors, clutterKey, copiesByBox, findFolder, folderKey, folderLine, folderSkills, folders, roots, sizeText, skillProblems, tilde, visibleRows, withProblem,
} from "../../web/src/pages/skills/layouts/tree/model.ts";

const T: SkillThresholds = { medianBytes: 4000, medianLines: 75, bloatBytes: 12000, nearDuplicate: 0.8, staleCheckoutDays: 30, source: "test" };

const copy = (path: string, over: Partial<SkillCopy> = {}): SkillCopy => ({
  id: `metal:${path}`, box: "metal", path, role: "source", installId: null, link: null, realPath: over.link ?? path, exists: true, hash: "h", lines: 10,
  bytes: 1000, folderBytes: 1000, files: 1, mtime: null, loadedBy: ["prime"], changedLines: 0, checkout: null, ...over,
});

const skill = (name: string, copies: SkillCopy[], uses: number, verdicts: SkillVerdictRow[] = []): SkillEntry => ({
  id: `git:x/${name}`, name, description: "", owner: { kind: "owner" }, source: { kind: "git", repo: "x", path: `skills/${name}` }, installs: [], copies,
  size: { lines: 10, bytes: 1000, ratio: 0.25 }, verdicts, extraCopies: [], use: { uses, sessions: uses, lastUse: null, byKind: {} }, preimported: false, sees: [],
});

const node = (name: string, path: string, copies: number, links: number, children: SkillTreeNode[] = []): SkillTreeNode => ({ name, path, copies, links, loadedBy: ["prime"], children });

const stale = { root: "/home/u/code/old", branch: "main", headAt: "2026-04-01T00:00:00Z", stale: true };
const board = skill("board", [copy("/home/u/.prime/agent/skills/board", { link: "/home/u/src/x/skills/board" }), copy("/home/u/code/old/skills/board", { role: "checkout", checkout: stale, changedLines: 12 })], 40, [
  { rule: "stale-clone", action: "remove", detail: "old clone", copyId: "metal:/home/u/code/old/skills/board", other: null },
]);
const wiki = skill("wiki", [copy("/home/u/.prime/agent/skills/wiki", { link: "/home/u/gone", exists: false })], 0);
const big = skill("big", [copy("/home/u/.prime/agent/skills/big", { bytes: 20000 })], 3, [{ rule: "bloated", action: "note", detail: "5x", copyId: null, other: null }]);

const source = skill("tool", [copy("/home/u/src/x/skills/tool", { loadedBy: [] }), copy("/home/u/.prime/agent/skills/tool", { link: "/home/u/src/x/skills/tool" })], 1);

const box: SkillBoxState = {
  box: "metal", state: "ok", scannedAt: null, lastOkAt: null, since: null, seconds: null, message: null, error: null,
  tree: [node("home/u", "/home/u", 2, 3, [node(".prime/agent/skills", "/home/u/.prime/agent/skills", 1, 2), node("code/old/skills", "/home/u/code/old/skills", 1, 0)])],
};
const view = { skills: [board, wiki, big] } as Parameters<typeof copiesByBox>[0];

test("a home folder reads as ~ on either box", () => {
  assert.equal(tilde("/home/sieun/.prime/agent/skills"), "~/.prime/agent/skills");
  assert.equal(tilde("/Users/sieunpark/code"), "~/code");
  assert.equal(tilde("/opt/skills"), "/opt/skills");
});

test("old clones fold into the clutter group, and live roots stay children", () => {
  const list = folders(box, copiesByBox(view).get("metal") ?? []);
  const top = list[0]!;
  assert.equal(top.name, "~");
  assert.deepEqual(top.children.map(f => f.name), [".prime/agent/skills"]);
  assert.deepEqual(top.clutter.map(f => f.name), ["code/old/skills"]);
  assert.equal(top.children[0]!.broken, 1);
  assert.equal(top.problems.outdated, 1);
  assert.equal(top.problems.bloated, 1);
  assert.deepEqual(roots(list).map(f => f.node.path), ["/home/u/.prime/agent/skills"]);
  assert.equal(findFolder(list, "/home/u/code/old/skills")?.stale, true);
  assert.deepEqual(ancestors(list, "/home/u/code/old/skills"), ["/home/u", "/home/u/code/old/skills"]);
});

test("a source folder no tool lists reads as loaded through the links into it", () => {
  const withSource = { ...box, tree: [node("home/u", "/home/u", 1, 1, [node(".prime/agent/skills", "/home/u/.prime/agent/skills", 0, 1), { ...node("src/x/skills", "/home/u/src/x/skills", 1, 0), loadedBy: [] }])] };
  const list = folders(withSource, copiesByBox({ skills: [source] } as Parameters<typeof copiesByBox>[0]).get("metal") ?? []);
  assert.equal(folderLine(list[0]!.children[1]!), "read through 1 link, 1 skill folder");
});

test("a folder line names its loaders and links against folders", () => {
  const list = folders(box, copiesByBox(view).get("metal") ?? []);
  assert.equal(folderLine(list[0]!.children[0]!), "Prime, 1 folder, 2 links");
  assert.equal(folderLine(list[0]!.clutter[0]!), "Prime, 1 skill folder");
});

test("a folder lists its most used skills first and the never used apart", () => {
  const { used, never } = folderSkills(copiesByBox(view).get("metal") ?? [], "/home/u/.prime/agent/skills");
  assert.deepEqual(used.map(r => r.skill.name), ["board", "big"]);
  assert.deepEqual(never.map(r => r.skill.name), ["wiki"]);
});

test("the problem filter keeps only folders with that problem", () => {
  const list = folders(box, copiesByBox(view).get("metal") ?? []);
  const only = withProblem(list, "outdated");
  assert.deepEqual(only[0]!.children.map(f => f.name), []);
  assert.deepEqual(only[0]!.clutter.map(f => f.name), ["code/old/skills"]);
  assert.deepEqual(skillProblems(board), ["outdated"]);
  assert.deepEqual(skillProblems(board, "metal:/home/u/.prime/agent/skills/board"), []);
});

test("the visible rows follow what is open, with the clutter group after the live folders", () => {
  const shown = [{ box: "metal", folders: folders(box, copiesByBox(view).get("metal") ?? []) }];
  const top = folderKey("metal", "/home/u");
  assert.deepEqual(visibleRows(shown, new Set(["box:metal"])).map(r => r.id), ["box:metal", top]);
  const rows = visibleRows(shown, new Set(["box:metal", top, clutterKey(top)]));
  assert.deepEqual(rows.map(r => r.id), ["box:metal", top, folderKey("metal", "/home/u/.prime/agent/skills"), clutterKey(top), folderKey("metal", "/home/u/code/old/skills")]);
  assert.equal(rows.at(-1)!.parent, clutterKey(top));
});

test("size reads against the median", () => {
  assert.equal(sizeText(4000, T), "median size");
  assert.equal(sizeText(20000, T), "5.0× median");
  assert.equal(sizeText(1000, T), "0.3× median");
  assert.equal(sizeText(null, T), null);
});
