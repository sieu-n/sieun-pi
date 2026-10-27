// Guards the 10-18 stops of the chat service: one at 21:42:19Z took 49 s and one at 21:51:01Z 22 s, while the agent outbox's close waited on
// daemon reads (30 s each when the daemon is slow) that came before any send went out.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Outbox, type OutboxDeps, type Stored } from "../src/outbox.ts";

const send = (id: string, threadId: string) => ({ id, threadId, text: `hi ${threadId}`, images: [], mode: "steer" as const, fingerprint: `fp-${threadId}` });

test("a draining close waits for a send that is out, not for a delivery still on its daemon reads, which stays queued for the next start", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "outbox-stop-"));
  let releaseRead!: () => void;
  const read = new Promise<void>(resolve => { releaseRead = resolve; });
  let answerSend!: () => void;
  const answer = new Promise<void>(resolve => { answerSend = resolve; });
  const sent: string[] = [];
  const out = new Set<string>();
  const deps = (slow: boolean): OutboxDeps => ({ dir, log: () => {}, changed: () => {}, final: () => null,
    sleep: () => new Promise(resolve => setImmediate(resolve)), copy: async () => "absent",
    deliver: async (entry: Stored, sending) => {
      // "reads" waits on a daemon read before it sends; "out" sends at once and waits for the answer.
      if (slow && entry.threadId === "reads") await read;
      await sending();
      out.add(entry.threadId);
      if (slow && entry.threadId === "out") await answer;
      sent.push(entry.threadId);
    } });
  const first = new Outbox(deps(true));
  await first.submit(send("m-1", "reads"));
  await first.submit(send("m-2", "out"));
  while (!out.has("out")) await new Promise(resolve => setImmediate(resolve));
  let closed = false;
  const closing = first.close(true).then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, false, "the close waits while a send is out");
  answerSend();
  await closing;
  assert.deepEqual(sent, ["out"], "the close did not wait for the delivery still reading");
  releaseRead();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(sent, ["out"], "after the close that delivery sends nothing");
  const next = new Outbox(deps(false));
  await next.idle();
  await next.close(true);
  assert.deepEqual(sent, ["out", "reads"], "the next start sends it once");
});
