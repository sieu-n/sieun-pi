// 10-28 us-metal02: ~/scratch/mac-run held 56 per-job repo copies of Mac jobs that no owner record names, 43 of them links into the attic, and
// the kernel's guard refused every job's rm of them, since no session family owns them (c193 cleanup). `unowned` deletes exactly those.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };

test("unowned deletes an idle tree no record names with its attic copy, and keeps a recorded, used, fresh or job tree", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-unowned-"));
  process.env.HOME = home;
  const { reapUnowned, unownedSource, ATTIC, UNOWNED_IDLE_MS } = await import("../src/job-leftovers.ts");
  const attic = existsSync(ATTIC);
  t.after(() => { if (attic) rmSync(ATTIC + home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const runs = join(home, "scratch", "mac-run");
  const idle = join(runs, "dev_sieun-mac-billing");
  const recorded = join(runs, "dev_sieun-mac-vent");
  const used = join(runs, "dev_sieun-mac-mail");
  const fresh = join(runs, "dev_sieun-mac-schema-tag");
  const job = join(home, "scratch", "01a15769-0000-7000-8000-0000000000c1");
  const linked = join(runs, "fix-egress");
  for (const dir of [idle, recorded, used, fresh, job]) write(join(dir, "repo", "package.json"));
  const later = Date.now() + UNOWNED_IDLE_MS + 60_000;
  utimesSync(join(fresh, "repo", "package.json"), new Date(later - 60_000), new Date(later - 60_000));
  if (attic) { write(join(ATTIC + linked, "repo", "package.json")); symlinkSync(ATTIC + linked, linked); }
  const holder = spawn("sleep", ["60"], { cwd: join(used, "repo"), stdio: "ignore" });
  t.after(() => holder.kill());
  const source = { ...unownedSource, mounted: async () => [], records: async () => [{ path: join(recorded, "repo"), owner: "mac:01a11ba8/sub-3f5892fd" }] };
  const { removed, kept } = await reapUnowned(source, [idle, recorded, used, fresh, job, ...attic ? [linked] : []], later);
  assert.deepEqual(removed.sort(), [idle, ...attic ? [linked] : []].sort());
  assert.ok(!existsSync(idle));
  if (attic) assert.ok(!existsSync(ATTIC + linked) && !lstatSync(linked, { throwIfNoEntry: false }), "the attic copy and its link go");
  assert.match(kept.get(recorded) ?? "", /record of mac:01a11ba8\/sub-3f5892fd names/);
  assert.match(kept.get(used) ?? "", /process/);
  assert.match(kept.get(fresh) ?? "", /changed within the last 2 h/);
  assert.match(kept.get(job) ?? "", /own ~\/scratch\/<session id>/);
  for (const dir of [recorded, used, fresh, job]) assert.ok(existsSync(join(dir, "repo", "package.json")), `${dir} stays`);
});

test("unowned keeps every tree when a box's records cannot be read", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-unowned-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { reapUnowned, unownedSource, UNOWNED_IDLE_MS } = await import("../src/job-leftovers.ts");
  const idle = join(home, "scratch", "mac-run", "sieun_dev");
  write(join(idle, "repo", "package.json"));
  const source = { ...unownedSource, mounted: async () => [], records: async () => { throw new Error("the records on mac: ssh timed out"); } };
  const { removed, kept } = await reapUnowned(source, [idle], Date.now() + UNOWNED_IDLE_MS + 60_000);
  assert.deepEqual(removed, []);
  assert.match(kept.get(idle) ?? "", /could not all be read: the records on mac/);
  assert.ok(existsSync(join(idle, "repo", "package.json")));
});
