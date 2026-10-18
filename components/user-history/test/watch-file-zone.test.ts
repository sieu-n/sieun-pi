// Guards the 16:46Z reading on 10-18: the chat wrote its watch lines under TZ=Asia/Seoul, so from 15:00Z they went to 2026-10-19.jsonl, and a
// precheck run from a UTC shell read only 2026-10-18.jsonl and counted all 30 minutes as having no watch line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWatch } from "../src/mac-usable-watch.ts";

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
