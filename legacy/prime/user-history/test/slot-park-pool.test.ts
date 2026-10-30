import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { readFileSlotPark } from "../src/slot-park.ts";

/** Holds every thread of libuv's pool for about `ms`, as the chat's other file reads and a CI burst on 10-30 did. */
async function poolBusyFor(ms: number): Promise<Promise<void>[]> {
  const threads = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
  const started = performance.now();
  await new Promise<void>((resolve, reject) => pbkdf2("x", "y", 20_000, 32, "sha256", error => error ? reject(error) : resolve()));
  const iterations = Math.max(20_000, Math.round(20_000 * ms / Math.max(1, performance.now() - started)));
  return Array.from({ length: threads * 2 }, () => new Promise<void>(resolve => { pbkdf2("x", "y", iterations, 32, "sha256", () => resolve()); }));
}

test("a session file read before answers its slot park again without waiting for a thread of the pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slot-park-pool-"));
  try {
    const file = join(dir, "01a18eff-0000-7000-8000-000000000000.jsonl");
    writeFileSync(file, JSON.stringify({ type: "message", timestamp: "2026-10-30T22:39:00.000Z", message: { role: "assistant", stopReason: "stop" } }) + "\n");
    const first = await readFileSlotPark(file);
    const held = await poolBusyFor(600);
    const started = performance.now();
    const again = await readFileSlotPark(file);
    const waited = performance.now() - started;
    await Promise.all(held);
    assert.deepEqual(again, first);
    assert.ok(waited < 150, `the second read waited ${Math.round(waited)} ms behind a full thread pool`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
