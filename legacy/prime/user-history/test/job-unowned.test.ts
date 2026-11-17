// 10-28 us-metal02: ~/scratch/mac-run held 56 per-job repo copies of Mac jobs that no owner record names, 43 of them links into the attic, and
// the kernel's guard refused every job's rm of them, since no session family owns them (c193 cleanup). `unowned` deletes exactly those.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

test("unowned deletes an idle tree whose hard-linked file has a new ctime and an old mtime, and keeps a single-link file with a new ctime", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-unowned-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { reapUnowned, unownedSource, UNOWNED_IDLE_MS } = await import("../src/job-leftovers.ts");
  const runs = join(home, "scratch", "mac-run");
  const linked = join(runs, "dev_sieun-mac-et");
  const copied = join(runs, "dev_sieun-mac-mm");
  const store = write(join(home, "store", "index.d.ts"));
  const types = join(linked, "repo", "node_modules", "ssf", "types");
  mkdirSync(types, { recursive: true });
  linkSync(store, join(types, "index.d.ts"));
  write(join(copied, "repo", "package.json"));
  const old = new Date(Date.now() - UNOWNED_IDLE_MS - 60 * 60_000);
  for (const path of [store, join(copied, "repo", "package.json"), types, join(types, ".."), join(types, "..", ".."), join(linked, "repo"), linked, join(copied, "repo"), copied])
    utimesSync(path, old, old);
  const since = Date.now() - UNOWNED_IDLE_MS;
  assert.ok(statSync(store).nlink === 2 && statSync(store).ctimeMs >= since && statSync(store).mtimeMs < since, "the linked file's ctime is new and its mtime old");
  const source = { ...unownedSource, mounted: async () => [], records: async () => [] };
  const { removed, kept } = await reapUnowned(source, [linked, copied]);
  assert.deepEqual(removed, [linked]);
  assert.ok(!existsSync(linked));
  assert.match(kept.get(copied) ?? "", /package\.json changed within the last 2 h/);
});

// 11-18 Mac: BSD find refused `-newermt @<epoch>` with "Can't parse date/time", the reaper read that as a fresh tree, and it kept
// ~/scratch/sieun-pi-runtime-8fClKx (258 MB, idle since 19:52Z 11-17) and every other tree. A find failure keeps the tree and says so.
test("unowned reads idle trees with a find that takes no @<epoch> date, and a failed find keeps its tree as unread, not fresh", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-unowned-"));
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const { reapUnowned, unownedSource, UNOWNED_IDLE_MS } = await import("../src/job-leftovers.ts");
  const real = execFileSync("sh", ["-c", "command -v find"], { encoding: "utf8" }).trim();
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "find"), `#!/bin/sh\nfor a in "$@"; do case "$a" in @*) echo "find: Can't parse date/time: $a" >&2; exit 1;; esac; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${path}`;
  const idle = join(home, "scratch", "sieun-pi-runtime-8fClKx");
  const broken = join(home, "scratch", "sieun-pi-runtime-x");
  for (const dir of [idle, broken]) write(join(dir, "release", "package.json"));
  const later = Date.now() + UNOWNED_IDLE_MS + 60_000;
  const source = { ...unownedSource, mounted: async () => [], records: async () => [] };
  const first = await reapUnowned(source, [idle], later);
  assert.deepEqual(first.removed, [idle], first.kept.get(idle));
  writeFileSync(join(bin, "find"), "#!/bin/sh\necho 'find: boom' >&2\nexit 1\n", { mode: 0o755 });
  const { removed, kept } = await reapUnowned(source, [broken], later);
  assert.deepEqual(removed, []);
  assert.match(kept.get(broken) ?? "", /could not be read whole: find failed: find: boom/);
  assert.ok(existsSync(join(broken, "release", "package.json")));
});

test("unowned --scratch judges every folder in ~/scratch and no loose file", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-unowned-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const name of ["a", "b"]) write(join(home, "scratch", name, "x"));
  write(join(home, "scratch", "shot.png"));
  const out = execFileSync(process.execPath, ["--import", "tsx", "src/job-leftovers.ts", "unowned", "--scratch"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, HOME: home }, encoding: "utf8" });
  const { kept } = JSON.parse(out) as { kept: string[] };
  assert.deepEqual(kept.map(line => line.split(":")[0]).sort(), [join(home, "scratch", "a"), join(home, "scratch", "b")]);
});
