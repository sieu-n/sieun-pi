// Guards the 10-22 retry loop: a message to chat-057a (01a14210) failed on "No API key found for openai-codex." 451 times, one try each 30 s
// from 15:00:17Z until it went on try 452 at 18:54:03Z.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_BACKOFF_MS, Outbox, SAME_ERROR_MAX_BACKOFF_MS } from "../src/outbox.ts";

const send = (id: string) => ({ id, threadId: "01a14210", text: "report", images: [], mode: "steer" as const, fingerprint: `fp-${id}` });

async function waits(errors: readonly string[], quiet?: (error: unknown) => boolean): Promise<{ waits: number[]; lines: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "outbox-backoff-"));
  const waits: number[] = [];
  const lines: string[] = [];
  let tries = 0;
  const outbox = new Outbox({ dir, log: line => lines.push(line), changed: () => {}, final: () => null, copy: async () => "absent",
    uncertain: () => false, sleep: async ms => { waits.push(ms); }, ...quiet ? { quiet } : {},
    deliver: async (_entry, sending) => {
      await sending();
      const error = errors[tries++];
      if (error !== undefined) throw new Error(error);
    } });
  try {
    await outbox.submit(send("m-1"));
    await outbox.idle();
    await outbox.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
  return { waits, lines };
}

test("tries that keep failing the same way back off past 30 s, up to 10 min, and say so in their log line", async () => {
  const { waits: seen, lines } = await waits(Array(12).fill("No API key found for openai-codex."));
  assert.deepEqual(seen, [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  assert.equal(Math.max(...seen), SAME_ERROR_MAX_BACKOFF_MS);
  assert.match(lines[11]!, /try 12: No API key found for openai-codex\. \(the same failure 12 tries in a row; next try in 600 s\)$/);
  assert.match(lines[4]!, /try 5: No API key found for openai-codex\.$/);
});

test("a try that fails another way goes back to the 30 s wait", async () => {
  const errors = [...Array(8).fill("No API key found for openai-codex."), "Timed out after 30000ms", "No API key found for openai-codex."];
  const { waits: seen } = await waits(errors);
  assert.deepEqual(seen.slice(7), [240_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
});

test("a logged wait that repeats, such as a full target, keeps its 30 s read", async () => {
  const { waits: seen } = await waits(Array(8).fill("the target holds 20 unfinished messages, limit 20"), () => true);
  assert.deepEqual(seen.slice(4), [MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
});
