// Guards the 16:46Z reading on 10-18: the chat wrote its watch lines under TZ=Asia/Seoul, so from 15:00Z they went to 2026-10-19.jsonl, and a
// precheck run from a UTC shell read only 2026-10-18.jsonl and counted all 30 minutes as having no watch line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWatch, tailSince, watchFile } from "../src/mac-usable-watch.ts";

test("a reader in another time zone than the writer still finds the lines of the writer's next local day", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-tz-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "mac-usable"), { recursive: true });
  // What the chat under TZ=Asia/Seoul wrote at 16:45:30Z on 10-18: its local day was already 10-19.
  const line = { host: "us-metal02", at: "2026-10-18T16:45:30.000Z", workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0 };
  writeFileSync(join(dataDir, "mac-usable", "2026-10-19.jsonl"), JSON.stringify(line) + "\n");
  writeFileSync(join(dataDir, "mac-usable", "2026-10-18.jsonl"), "");
  const now = Date.parse("2026-10-18T16:46:00.000Z");
  const read = await readWatch(dataDir, now - 30 * 60_000, now);
  assert.deepEqual(read.map(entry => entry.at), ["2026-10-18T16:45:30.000Z"]);
});

// The watch's start read the last 30 minutes of its seed by parsing every line of the day files: 0.6 s of main thread at the release-1ca77d6
// start at 11:14:42Z on 10-25, while the first reads waited. A line lands up to a minute after its `at`, as a stop's line in flight does.
test("a read of the last 30 minutes reads only the file's tail, and keeps a line that landed after a newer one", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-tail-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "mac-usable"), { recursive: true });
  const day = Date.parse("2026-10-25T00:00:30.000Z");
  const pad = "x".repeat(10_000);
  const at = (ms: number) => ({ host: "us-metal02", at: new Date(ms).toISOString(), workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
    mac: { swapGb: null, pressureLevel: null }, cpuMs: 0, pad });
  const stamps = Array.from({ length: 690 }, (_, minute) => day + minute * 60_000);
  const late = stamps.at(-31)! + 20_000;
  stamps.splice(stamps.length - 30, 0, late);
  const file = watchFile(dataDir, day);
  writeFileSync(file, stamps.map(ms => JSON.stringify(at(ms))).join("\n") + "\n");
  const now = stamps.at(-1)!;
  const tail = await tailSince(file, now - 30 * 60_000);
  assert.ok(tail.length < statSync(file).size / 10, `read ${tail.length} bytes of ${statSync(file).size}`);
  const read = await readWatch(dataDir, now - 30 * 60_000, now);
  assert.deepEqual(read.map(entry => Date.parse(entry.at)), stamps.filter(ms => ms >= now - 30 * 60_000).sort((a, b) => a - b));
  assert.equal(read.filter(entry => Date.parse(entry.at) === late).length, 1);
});
