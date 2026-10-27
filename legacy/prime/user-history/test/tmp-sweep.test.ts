// 10-19 us-metal02 at 01:2xZ: /tmp, a tmpfs, held 9.2 GB with swap at 13.2 of 16 GB though no turn had run for most of the evening, 5.1 GB of it in
// 13,912 entries nobody held or named. The sweep deletes an entry once it sat unchanged for the idle window, no loaded or waking session names
// it and no process holds it, and keeps one with a live socket. It signals no process (10-19 02:06Z: a job's end SIGTERMed four release processes
// of other jobs that only named a shared helper's folder).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InsideProcess } from "../src/job-leftovers.ts";
import { keepersOf, namedIn, namedSince, pruneCaches, sweepTmp, tmpEntries, type TmpEntry, type TmpSweepSource } from "../src/tmp-sweep.ts";

const HOUR = 3_600_000;

test("a sweep deletes the stale entries no keeper names and no process holds, signals nothing, and keeps the rest", async () => {
  const now = Date.parse("2026-10-19T02:00:00Z");
  const entry = (name: string, changedAgoMs: number, extra: Partial<TmpEntry> = {}): TmpEntry =>
    ({ path: `/tmp/${name}`, name, bornMs: now - 20 * HOUR, changedMs: now - changedAgoMs, liveSocket: false, ...extra });
  const proc = (pid: number, dir: string, extra: Partial<InsideProcess> = {}): InsideProcess =>
    ({ pid, bytes: 1, started: pid, command: "x", dir, session: null, prime: false, shared: false, ...extra });
  let removed: readonly string[] = [];
  let read: [string, number][] = [];
  const source: TmpSweepSource = {
    root: "/tmp", idleMs: () => 10 * 60_000, now: () => now,
    entries: async () => [entry("cs", 14 * HOUR), entry("fresh", 60_000), entry("sock", 3 * HOUR, { liveSocket: true }), entry("named", 5 * HOUR),
      entry("p8iso-old", 6 * HOUR), entry("served", 4 * HOUR), entry("kernel-cwd", 4 * HOUR), entry("pm2-cwd", 4 * HOUR)],
    keepers: async () => [{ sessionFile: "a.jsonl" }],
    namedSince: async (file, since, root) => { read.push([file, since]); return namedIn('ran "python3 /tmp/named/x.py" and ls /tmp/cs-other /tmp/nope', root); },
    inside: async paths => {
      assert.deepEqual([...paths].sort(), ["/tmp/cs", "/tmp/kernel-cwd", "/tmp/p8iso-old", "/tmp/pm2-cwd", "/tmp/served"]);
      return [proc(11, "/tmp/p8iso-old"), proc(12, "/tmp/p8iso-old"), proc(13, "/tmp/served", { session: "01a14fbe-0000-7000-8000-000000000001" }),
        proc(14, "/tmp/kernel-cwd", { prime: true }), proc(15, "/tmp/pm2-cwd", { shared: true })];
    },
    remove: async paths => { removed = paths; return paths; },
    pruneCaches: async () => 4096,
  };
  const swept = await sweepTmp(source);
  assert.deepEqual([...removed].sort(), ["/tmp/cs"]);
  assert.equal(swept.cacheBytes, 4096);
  assert.deepEqual(read, [["a.jsonl", now - 20 * HOUR]]);

  read = [];
  removed = [];
  const off = await sweepTmp({ ...source, idleMs: () => null });
  assert.deepEqual(off, { removed: [], cacheBytes: 0 });
  assert.deepEqual(read, []);
});

test("the keepers are the loaded sessions and the ones a board.wake waits on", () => {
  const rows = [
    { sessionId: "a", sessionFile: "a.jsonl", activeSessionId: "x", lifecycle: "live" },
    { sessionId: "b", sessionFile: "b.jsonl", lifecycle: "live" },
    { sessionId: "c", sessionFile: "c.jsonl", lifecycle: "live" },
    { sessionId: "d", sessionFile: "d.jsonl", activeSessionId: "y", lifecycle: "archived" },
  ];
  assert.deepEqual(keepersOf(rows, new Set(["c"])).map(keeper => keeper.sessionFile), ["a.jsonl", "c.jsonl"]);
});

test("entries carry their newest change and live sockets, shared names stay out, and old compile cache files go", { skip: process.platform !== "linux" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "tmp-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = new Date(Date.now() - 5 * HOUR);
  for (const dir of ["tree/deep", "listen", "tsx-1001/a", "pytest-of-sieun"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "tree/deep/old.txt"), "x");
  writeFileSync(join(root, "tree/deep/new.txt"), "y");
  writeFileSync(join(root, "tsx-1001/a/stale.js"), "z".repeat(5000));
  writeFileSync(join(root, "tsx-1001/a/hot.js"), "w");
  for (const path of ["tree/deep/old.txt", "tree/deep", "tree", "tsx-1001/a/stale.js"]) utimesSync(join(root, path), old, old);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(join(root, "listen/s.sock"), resolve));
  t.after(() => server.close());
  const found = new Map((await tmpEntries(root, Date.now() + HOUR)).map(entry => [entry.name, entry]));
  assert.deepEqual([...found.keys()].sort(), ["listen", "tree"]);
  assert.ok(found.get("tree")!.changedMs > Date.now() - 60_000, "the newest change below the tree counts");
  assert.equal(found.get("tree")!.liveSocket, false);
  assert.equal(found.get("listen")!.liveSocket, true);
  const bytes = await pruneCaches(root, Date.now() - HOUR);
  assert.ok(bytes >= 4096);
  assert.deepEqual((await tmpEntries(join(root, "tsx-1001"), 0)).map(entry => entry.name), ["a"]);
  assert.equal(existsSync(join(root, "tsx-1001/a/stale.js")), false);
  assert.equal(existsSync(join(root, "tsx-1001/a/hot.js")), true);
});

test("a transcript's text since a time reaches back past it and names its entries", async t => {
  const dir = mkdtempSync(join(tmpdir(), "tmp-sweep-text-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "s.jsonl");
  const line = (at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });
  writeFileSync(file, [line("2026-10-18T10:00:00.000Z", "mkdir /tmp/early"), line("2026-10-18T12:00:00.000Z", "cd /tmp/later && ls")].join("\n") + "\n");
  writeFileSync(file, JSON.stringify({ type: "message", timestamp: "2026-10-18T12:30:00.000Z", message: { role: "toolResult", content: [{ type: "text", text: "made\n/tmp/listed\n" }] } }) + "\n", { flag: "a" });
  const named = await namedSince(file, Date.parse("2026-10-18T11:00:00Z"), "/tmp");
  assert.ok(named.has("later"));
  assert.ok(named.has("listed"), "a path after an escaped newline counts");
});

// 10-24 us-metal02: the chat's CPU profile pid626077 shows textSince decoding a whole transcript tail at once and holding the event loop up to
// 298 ms. The tail is now read and matched one chunk of whole lines at a time.
test("names read in small chunks match the names of the whole tail, a name across a chunk edge included, and stop at the old stamp", async t => {
  const dir = mkdtempSync(join(tmpdir(), "tmp-sweep-chunks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "s.jsonl");
  const line = (at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { content: [{ type: "text", text }] } });
  const lines = [line("2026-10-18T09:00:00.000Z", "mkdir /tmp/too-old"), line("2026-10-18T10:00:00.000Z", "x".repeat(300) + " /tmp/long-one")];
  for (let i = 0; i < 40; i++) lines.push(line(`2026-10-18T12:${String(i).padStart(2, "0")}:00.000Z`, `cd /tmp/dir-${i} && ls /tmp/caf\u00e9-${i} é`));
  writeFileSync(file, lines.join("\n") + "\n");
  const since = Date.parse("2026-10-18T11:00:00Z");
  const whole = await namedSince(file, since, "/tmp", 1 << 30);
  for (const chunk of [7, 64, 100, 333, 4096]) {
    const named = await namedSince(file, since, "/tmp", chunk);
    assert.deepEqual([...named].filter(name => name !== "too-old").sort(), [...whole].filter(name => name !== "too-old").sort(), `chunk ${chunk}`);
    if (chunk < 300) assert.equal(named.has("too-old"), false, `chunk ${chunk} reads past the line stamped before the time`);
  }
  assert.ok(whole.has("dir-39") && whole.has("dir-0") && whole.has("long-one") && whole.has("caf"));
});

test("naming the entries of a 64 MB transcript never holds the event loop 100 ms", { skip: process.platform !== "linux" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "tmp-sweep-big-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "s.jsonl");
  const block = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: "message", timestamp: "2026-10-18T12:00:00.000Z",
    message: { content: [{ type: "text", text: `ran /tmp/job-${i}/run.py ` + "y".repeat(400) }] } })).join("\n") + "\n";
  writeFileSync(file, block.repeat(Math.ceil(64 * 1024 ** 2 / block.length)));
  // A gap counts the main thread's own CPU time, not wall time: the release suite on us-metal02 at load 125 to 157 on 80 cores on 10-25 read
  // wall gaps of 124 ms twice for code that passed alone, since a held core's wait for the scheduler is no work the sweep holds the loop for.
  // Each test file runs in its own process, so other files' work never counts here. measured: on us-metal02 on 10-25 at 934b2b60 the longest
  // CPU gap read 30 to 42 ms alone and 35 to 41 ms in 6 full suites at load 110 to 200, whose wall gaps read 67 to 186 ms, and a 200 ms busy
  // loop added after each chunk read 229 to 241 ms.
  const cpuMs = (): number => { const used = process.threadCpuUsage(); return (used.user + used.system) / 1000; };
  let last = cpuMs();
  let lastWall = performance.now();
  let longest = 0;
  let longestWall = 0;
  const tick = setInterval(() => {
    const now = cpuMs(), wall = performance.now();
    longest = Math.max(longest, now - last); longestWall = Math.max(longestWall, wall - lastWall);
    last = now; lastWall = wall;
  }, 1);
  const named = await namedSince(file, Date.parse("2026-10-18T11:00:00Z"), "/tmp");
  clearInterval(tick);
  assert.equal(named.size, 2000);
  assert.ok(longest < 100, `the main thread ran ${longest.toFixed(0)} ms of CPU between two timer ticks (longest wall gap ${longestWall.toFixed(0)} ms)`);
});
