import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAppended } from "../scripts/duties/read-appended.ts";

const lines = async (path: string, start: number) => {
  const seen: string[] = [];
  const result = await readAppended(path, start, [{ text: "skills/" }], line => { seen.push(line); });
  return { ...result, seen };
};

test("readAppended reads only the lines appended after the offset, and returns the offset unchanged with no bytes read when nothing was appended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-appended-"));
  try {
    const file = join(dir, "t.jsonl");
    await writeFile(file, '{"a":"skills/one"}\n{"b":2}\n');
    const first = await lines(file, 0);
    assert.deepEqual(first.seen, ['{"a":"skills/one"}']);
    const same = await lines(file, first.offset);
    assert.deepEqual(same, { offset: first.offset, bytes: 0, seen: [] });
    const long = `{"c":"${"x".repeat(9000)} skills/two"}`;
    await appendFile(file, `${long}\n{"d":"skills/three"}\n{"partial":"skills/`);
    const next = await lines(file, first.offset);
    assert.deepEqual(next.seen, [long, '{"d":"skills/three"}']);
    assert.equal(next.offset, first.offset + long.length + 1 + '{"d":"skills/three"}'.length + 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("readAppended returns the offset for a missing file or one shorter than the offset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-appended-"));
  try {
    assert.deepEqual(await lines(join(dir, "gone.jsonl"), 7), { offset: 7, bytes: 0, seen: [] });
    const file = join(dir, "short.jsonl");
    await writeFile(file, "{}\n");
    assert.deepEqual(await lines(file, 50), { offset: 50, bytes: 0, seen: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
