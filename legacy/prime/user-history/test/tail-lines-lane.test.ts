// From release-e709db1 on 10-28 every chat start stalled us-metal02's event loop 1.4 to 3 s: the slot-park pass started a tail read of every
// chat's stopped jobs at once, and libuv handed all the reads that came back meanwhile to one loop turn, which split each into lines.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tailLines } from "../src/cut-end.ts";

test("tail reads started together come back a few per loop turn, so the loop keeps turning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tail-lines-"));
  try {
    const line = JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(400) } });
    const files = await Promise.all(Array.from({ length: 200 }, async (_, index) => {
      const file = join(dir, `${index}.jsonl`);
      await writeFile(file, Array.from({ length: 300 }, () => line).join("\n"));
      return file;
    }));
    let done = 0;
    let most = 0;
    let turning = true;
    let since = 0;
    const turn = (): void => { most = Math.max(most, done - since); since = done; if (turning) setImmediate(turn); };
    setImmediate(turn);
    const reads = await Promise.all(files.map(file => tailLines(file, 128_000).then(lines => { done++; return lines; })));
    turning = false;
    assert.equal(reads.length, 200);
    assert.ok(reads.every(lines => lines.length > 200), "each read holds its file's last lines");
    assert.ok(most <= 8, `one loop turn finished ${most} tail reads`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
