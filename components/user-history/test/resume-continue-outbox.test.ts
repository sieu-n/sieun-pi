// Guards option B of the 10-23 harness load page (wiki: sessions/2026/10/23/0132-harness-load-discussion/prime-under-load.html). From 10-19 to
// 10-22 the job sweep's own "continue" (resume_paused.py through prime-agent send or daemon-cli.mjs) timed out 96 times with no copy check,
// and on 10-22 four of them reached their job 17 to 107 s after the CLI gave up, so the next pass could send a second one. The pass now hands
// its continue to api/agent/notice as kind "retry", and the agent outbox looks for a copy before it sends again.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { asset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";

// s3int9 metal02 update, whose sweep continue timed out at 05:43Z on 10-25 (service.log).
const JOB = "01a1718a-d14b-723d-8bf3-423bd8ac644a";
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message".';

test("a resume continue whose send timed out but landed goes once, and a second pass's copy joins it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "resume-continue-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, `${JOB}.jsonl`);
  await writeFile(file, "");
  let now = Date.parse("2026-10-25T05:43:00Z");
  const sent: string[] = [];
  const lines: string[] = [];
  // The daemon takes the first send but answers late, so the service gives up at 30 s; the job writes the continue 74 s later.
  const outbox = new AgentOutbox(join(dir, "agent-outbox"), {
    log: line => { lines.push(line); }, now: () => now, sleep: async () => { now += 30_000; await new Promise(resolve => setImmediate(resolve)); },
    send: async (_session, text) => {
      sent.push(text);
      if (sent.length > 1) return "sent";
      now += 30_000;
      await appendFile(file, JSON.stringify({ type: "custom_message", customType: "agent_message", details: { message: text }, timestamp: new Date(now + 74_000).toISOString() }) + "\n");
      throw new Error(TIMEOUT);
    },
    target: async () => ({ queued: [], busy: false, unfinished: 0 }),
    fileOf: async () => file,
  });
  t.after(() => outbox.close());
  const backend = { close: async () => {}, messages: outbox } as unknown as ChatBackend;
  const empty = asset(Buffer.from(""), "text/plain");
  const server = await startChatServer({ backend, bundle: { js: empty, css: empty, version: "resume-outbox" }, port: 0, capability: "cap", csrfToken: "token",
    stopToken: "stop", identity: { pid: process.pid, instanceId: "resume-outbox", socketPath: join(dir, "no-daemon.sock") }, onStop: async () => {} });
  t.after(() => server.close());
  const post = async (body: unknown) => {
    const response = await fetch(new URL("api/agent/notice", server.url), { method: "POST",
      headers: { "content-type": "application/json", "x-chat-token": "token", origin: new URL(server.url).origin }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() as unknown };
  };
  const pass = { to: JOB, message: "continue", kind: "retry", root: JOB };
  assert.deepEqual(await post(pass), { status: 200, value: { deliveryStatus: "queued", session: JOB } });
  assert.deepEqual(await post(pass), { status: 200, value: { deliveryStatus: "queued", session: JOB } });
  await outbox.outbox.idle();
  assert.deepEqual(sent, ["continue"], "the copy check finds the first continue landed, so nothing goes again");
  const kept = await Promise.all((await readdir(join(dir, "agent-outbox"))).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(join(dir, "agent-outbox", name), "utf8")) as { text: string; state: string; kind?: string; attempts: number }));
  assert.deepEqual(kept.map(entry => ({ text: entry.text, state: entry.state, kind: entry.kind, attempts: entry.attempts })),
    [{ text: "continue", state: "delivered", kind: "retry", attempts: 1 }]);
  assert.ok(lines.some(line => line.includes("is landed from the send at")), lines.join("\n"));
  assert.equal((await post({ ...pass, kind: "wake" })).status, 400, "the route takes only the resume's kind");
});
