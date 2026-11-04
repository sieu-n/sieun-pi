// d7 11-04: the 01:02:13Z tmp sweep read its keepers' transcripts with a fresh buffer of up to 4 MB each, outside the V8 heap, and at 01:02:01Z
// those reads ran beside 541 ms of garbage collection in a 750 ms run of the chat's main thread (d7 read a 1.19 s loop stall for 01:02Z). The
// sweep's reads now share one buffer, so a sweep over many transcripts allocates it once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { namedSince } from "../src/tmp-sweep.ts";

test("namedSince over several transcripts allocates its read buffer once and still finds each one's names", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-buffer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filler = `{"type":"message","timestamp":"2026-11-04T01:00:00.000Z","text":"${"x".repeat(2000)}"}\n`.repeat(400);
  const files = Array.from({ length: 6 }, (_, n) => {
    const file = join(dir, `s${n}.jsonl`);
    writeFileSync(file, filler + `{"type":"message","timestamp":"2026-11-04T01:01:00.000Z","text":"wrote /tmp/job-${n}.log"}\n`);
    return file;
  });
  const allocs = t.mock.method(Buffer, "allocUnsafe");
  const found: string[] = [];
  for (const file of files) found.push(...await namedSince(file, Date.parse("2026-11-04T00:00:00Z"), "/tmp", 256 * 1024));
  assert.deepEqual(found, files.map((_, n) => `job-${n}.log`));
  const big = allocs.mock.calls.filter(call => Number(call.arguments[0]) >= 64 * 1024).length;
  assert.ok(big <= 1, `the six reads allocated ${big} buffers of 64 KB or more`);
});
