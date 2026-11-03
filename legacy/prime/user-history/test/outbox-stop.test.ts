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

test("a draining close stops waiting for a send whose answer never comes, and the next start looks for that send before it goes again", { timeout: 30_000 }, async () => {
  // 11-03 18:57:45Z: the stop's drain waited on a notice's prompt to the Mac, whose relay had gone silent, and systemd killed the service at
  // 90 s, which ate release-chat's 60 s answer window. The same happened at 23:28Z on 10-29.
  const dir = await mkdtemp(join(tmpdir(), "outbox-stop-"));
  const lines: string[] = [];
  const sent: string[] = [];
  const looked: (number | undefined)[] = [];
  const base = { dir, changed: () => {}, final: () => null, sleep: () => new Promise<void>(resolve => setImmediate(resolve)), drainMs: 200 };
  let out = false;
  const first = new Outbox({ ...base, log: line => lines.push(line), copy: async () => "absent",
    deliver: async (_entry, sending) => { await sending(); out = true; await new Promise(() => {}); } });
  await first.submit(send("m-1", "mac"));
  while (!out) await new Promise(resolve => setImmediate(resolve));
  const at = Date.now();
  const ended = await Promise.race([first.close(true).then(() => "closed"), new Promise(resolve => setTimeout(() => resolve("still waiting"), 5_000))]);
  assert.equal(ended, "closed", "the close ends though the send has no answer");
  assert.ok(Date.now() - at < 2_000, `the close took ${Date.now() - at} ms`);
  assert.ok(lines.some(line => /mac had no answer 0\.2 s into the stop/.test(line)), lines.join("\n"));
  const next = new Outbox({ ...base, log: () => {}, copy: async (entry, since) => { looked.push(since); return "landed"; },
    deliver: async entry => { sent.push(entry.id); } });
  await next.idle();
  await next.close(true);
  assert.equal(looked.length, 1, "the next start looked for the send");
  assert.equal(typeof looked[0], "number");
  assert.deepEqual(sent, [], "and did not send it again");
});
