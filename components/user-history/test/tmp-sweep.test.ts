// 10-19 us-metal02 at 01:2xZ: /tmp, a tmpfs, held 9.2 GB with swap at 13.2 of 16 GB though no turn had run for most of the evening, 5.1 GB of it in
// 13,912 entries nobody held or named. The sweep deletes an entry once it sat unchanged for the idle window, no loaded or waking session names
// it and no process but its own rig holds it, and keeps one with a live socket.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InsideProcess } from "../src/job-leftovers.ts";
import { keepersOf, namedIn, pruneCaches, sweepTmp, textSince, tmpEntries, type TmpEntry, type TmpSweepSource } from "../src/tmp-sweep.ts";

const HOUR = 3_600_000;

test("a sweep deletes the stale entries no keeper names and only a rig holds, stops that rig, and keeps the rest", async () => {
  const now = Date.parse("2026-10-19T02:00:00Z");
  const entry = (name: string, changedAgoMs: number, extra: Partial<TmpEntry> = {}): TmpEntry =>
    ({ path: `/tmp/${name}`, name, bornMs: now - 20 * HOUR, changedMs: now - changedAgoMs, liveSocket: false, ...extra });
  const proc = (pid: number, dir: string, extra: Partial<InsideProcess> = {}): InsideProcess =>
    ({ pid, bytes: 1, started: pid, command: "x", dir, session: null, prime: false, shared: false, ...extra });
  const killed: [number, string][] = [];
  let removed: readonly string[] = [];
  let read: [string, number][] = [];
  const source: TmpSweepSource = {
    root: "/tmp", idleMs: () => 10 * 60_000, now: () => now,
    entries: async () => [entry("cs", 14 * HOUR), entry("fresh", 60_000), entry("sock", 3 * HOUR, { liveSocket: true }), entry("named", 5 * HOUR),
      entry("p8iso-old", 6 * HOUR), entry("served", 4 * HOUR), entry("kernel-cwd", 4 * HOUR), entry("pm2-cwd", 4 * HOUR)],
    keepers: async () => [{ sessionFile: "a.jsonl" }],
    textSince: async (file, since) => { read.push([file, since]); return 'ran "python3 /tmp/named/x.py" and ls /tmp/cs-other /tmp/nope'; },
    inside: async paths => {
      assert.deepEqual([...paths].sort(), ["/tmp/cs", "/tmp/kernel-cwd", "/tmp/p8iso-old", "/tmp/pm2-cwd", "/tmp/served"]);
      return [proc(11, "/tmp/p8iso-old"), proc(12, "/tmp/p8iso-old"), proc(13, "/tmp/served", { session: "01a14fbe-0000-7000-8000-000000000001" }),
        proc(14, "/tmp/kernel-cwd", { prime: true }), proc(15, "/tmp/pm2-cwd", { shared: true })];
    },
    started: async pid => pid,
    kill: (pid, signal) => { killed.push([pid, signal]); },
    later: (_ms, run) => run(),
    remove: async paths => { removed = paths; return paths; },
    pruneCaches: async () => 4096,
  };
  const swept = await sweepTmp(source);
  assert.deepEqual([...removed].sort(), ["/tmp/cs", "/tmp/p8iso-old"]);
  assert.deepEqual(swept.stopped.map(entry => entry.pid), [11, 12]);
  assert.deepEqual(killed, [[11, "SIGTERM"], [12, "SIGTERM"], [11, "SIGKILL"], [12, "SIGKILL"]]);
  assert.equal(swept.cacheBytes, 4096);
  assert.deepEqual(read, [["a.jsonl", now - 20 * HOUR]]);

  read = [];
  removed = [];
  const off = await sweepTmp({ ...source, idleMs: () => null });
  assert.deepEqual(off, { removed: [], stopped: [], cacheBytes: 0 });
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
  const text = await textSince(file, Date.parse("2026-10-18T11:00:00Z"));
  const named = namedIn(text, "/tmp");
  assert.ok(named.has("later"));
  assert.ok(named.has("listed"), "a path after an escaped newline counts");
});
