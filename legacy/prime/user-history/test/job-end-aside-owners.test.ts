// 10-28: the aside-browser skill has kept its tab records in ~/.local/state/aside-browser/owners since 10-18 (ea2c0a4c), one file per agent
// session, and a job's end read only the old aside-browser-tabs.json in the session folder. 1,949 job ends in the us-metal02 service log closed
// 0 Aside tabs, and finished jobs kept theirs open in the owner's Aside (32 renderers at 4.9 GB on 10-27 at 23:36Z). A job's end now closes the
// tabs those records give to its session folder and the folders under it, deletes those records, and leaves every other record alone.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const box = mkdtempSync(join(tmpdir(), "job-end-aside-owners-"));
process.env.HOME = box;
const owners = join(box, "owners");
process.env.ASIDE_BROWSER_STATE = owners;
const { artifactsRoot, closeAsideTabs, endLeftovers } = await import("../src/job-leftovers.ts");
type Source = Parameters<typeof endLeftovers>[0];
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";

function source(closed: string[][]): Source {
  return { strays: async () => [], started: async () => null, kill: () => {}, closeTabs: async ids => { closed.push([...ids]); return ids.length; }, later: () => {},
    removeCopies: async () => [], inside: async () => [], removeTmp: async () => [], stopContainers: async () => [], stopUnits: async () => [],
    writeOwned: async () => {}, artifactCopies: async () => [], kernelStates: async () => [], stopServices: async () => [] };
}

function record(name: string, owner: string, tabs: Record<string, string>): string {
  mkdirSync(owners, { recursive: true });
  const file = join(owners, `${name}.json`);
  writeFileSync(file, JSON.stringify({ owner, host: "Sieuns-MacBook-Pro.local", pid: 71223, start: "", tabs }));
  return file;
}

test("a job's end closes the Aside tabs the skill recorded for its session and its subagents, and keeps other sessions' records", async t => {
  t.after(() => rmSync(owners, { recursive: true, force: true }));
  const job = join(artifactsRoot(), CHAT, "sub-b2d345de");
  mkdirSync(join(job, "sub-7696232a"), { recursive: true });
  const own = record("0aa27d0bf5623995", job, { A1: "http://pinmove.localhost:5180/app/inbox" });
  const sub = record("87ede5d4a5aa5069", join(job, "sub-7696232a"), { B1: "http://pinmove.localhost:5180/app/dashboards", B2: "http://pinmove.localhost:5180/app/tags" });
  const sibling = record("3ebadd45aa7ce362", join(artifactsRoot(), CHAT, "sub-b2d345de0"), { C1: "http://bwb.localhost:5180/app/campaigns" });
  const other = record("68ac126728a13b66", join(artifactsRoot(), CHAT, "sub-60d7deff", "sub-3d516c55"), { D1: "http://bestof.localhost:5180/app/connections" });
  const closed: string[][] = [];
  const left = await endLeftovers(source(closed), job);
  assert.deepEqual(closed.map(ids => [...ids].sort()), [["A1", "B1", "B2"]]);
  assert.equal(left.tabs, 3);
  assert.deepEqual([existsSync(own), existsSync(sub), existsSync(sibling), existsSync(other)], [false, false, true, true]);
});

test("a failed close keeps the records, so the next end or deleted-jobs sweep closes the tabs", async t => {
  t.after(() => rmSync(owners, { recursive: true, force: true }));
  const job = join(artifactsRoot(), CHAT, "sub-2f8d65c2");
  const file = record("bfb45dc227c545cc", job, { E1: "http://fy2.localhost:5180/app/dashboards" });
  const left = await endLeftovers({ ...source([]), closeTabs: async () => { throw new Error("aside repl: Profile 0 is not connected to the daemon"); } }, job);
  assert.equal(left.tabs, 0);
  assert.ok(existsSync(file));
});

test("the Aside close sends Page.close through page.close({runBeforeUnload: true}), which closes a tab another REPL session opened", { skip: process.platform === "win32" }, async () => {
  const cli = join(box, "aside");
  const seen = join(box, "seen.js");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s' "$2" > '${seen}'\necho 'LEFTOVER_CLOSED 1'\n`);
  chmodSync(cli, 0o755);
  assert.equal(await closeAsideTabs(["F1"], cli), 1);
  const code = readFileSync(seen, "utf8");
  assert.match(code, /\.close\(\{ runBeforeUnload: true \}\)/);
  assert.doesNotMatch(code, /window\.close/);
});
