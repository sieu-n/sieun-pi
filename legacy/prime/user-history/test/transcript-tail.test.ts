import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTurnSince, transcriptTail, turnSince } from "../src/held-turns.ts";

// The alert bridge reads a watched job's transcript every 30 s (alert-bridge.ts `watch`). On 11-01 a whole read of a 131 MB transcript took
// 870 to 1,010 ms of the chat's main thread, so the read stops at the first chunk stamped before the fire.
const at = (minute: number): string => new Date(Date.parse("2026-11-01T05:00:00.000Z") + minute * 60_000).toISOString();
const entry = (n: number, minute: number, message: object): string =>
  JSON.stringify({ type: "message", id: `e${n}`, parentId: n ? `e${n - 1}` : null, timestamp: at(minute), message });
const toolResult = (n: number, minute: number, text: string): string => entry(n, minute, { role: "toolResult", content: [{ type: "text", text }] });
const assistant = (n: number, minute: number): string => entry(n, minute, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });

async function transcript(lines: string[]): Promise<{ file: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "transcript-tail-"));
  const file = join(dir, "s.jsonl");
  await writeFile(file, lines.join("\n") + "\n");
  return { file, done: () => rm(dir, { recursive: true, force: true }) };
}

test("the tail read stops at the first chunk stamped before the fire and finds the same turn as a whole read", async () => {
  const lines = [JSON.stringify({ type: "session", id: "s", timestamp: at(0) })];
  for (let n = 1; n <= 200; n++) lines.push(n % 10 ? toolResult(n, n / 10, "x".repeat(300)) : assistant(n, n / 10));
  const { file, done } = await transcript(lines);
  try {
    const since = Date.parse(at(18.5));
    const tail = await transcriptTail(file, since, 2048);
    assert.ok(tail.length < 8 * 1024, `read ${tail.length} bytes`);
    assert.ok(tail.endsWith("\n") && !tail.startsWith("\n"));
    for (const line of tail.trim().split("\n")) JSON.parse(line);
    assert.deepEqual(turnSince(tail, since), turnSince(lines.join("\n"), since));
    assert.deepEqual(await readTurnSince(file, since), { ran: true, at: Date.parse(at(20)) });
  } finally { await done(); }
});

test("a stamp quoted in a newer tool result does not end the tail read early", async () => {
  const old = toolResult(1, 1, "x".repeat(4000));
  const quoting = toolResult(3, 30, `{"type":"message","id":"q","parentId":null,"timestamp":"${at(1)}"} `.repeat(40));
  const { file, done } = await transcript([old, assistant(2, 25), quoting, toolResult(4, 31, "y".repeat(3000))]);
  try {
    assert.deepEqual(await readTurnSince(file, Date.parse(at(20))), { ran: true, at: Date.parse(at(25)) });
    const tail = await transcriptTail(file, Date.parse(at(20)), 1024);
    assert.ok(tail.includes('"id":"e2"'));
  } finally { await done(); }
});

test("a transcript with no turn after the fire, or no file, reads as no turn", async () => {
  const { file, done } = await transcript([assistant(1, 1), toolResult(2, 40, "z")]);
  try {
    assert.deepEqual(await readTurnSince(file, Date.parse(at(30))), { ran: false });
    assert.deepEqual(await readTurnSince(join(file, "missing"), 0), { ran: false });
  } finally { await done(); }
});
