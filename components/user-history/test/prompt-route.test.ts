import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import { recordPrompt } from "../src/prompt-capture.ts";
import { promptView, sessionFileFor } from "../src/prompt-view.ts";
import type { PromptView } from "../src/shared/prompt-view.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "prompt-view");
const CHAT = "01a1aaaa-0000-7000-8000-000000000001";
const DUTY_JOB = "01a1bbbb-0000-7000-8000-000000000002";
const SUBAGENT = "01a1cccc-0000-7000-8000-000000000003";

test("api/threads/:id/prompt: a duty job and an ended subagent the daemon does not list open by session id, with the job's subagents listed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-route-"));
  const sessions = join(dir, "sessions");
  await mkdir(sessions, { recursive: true });
  const chatFile = join(sessions, `${CHAT}.jsonl`);
  const jobFile = join(sessions, `${DUTY_JOB}.jsonl`);
  await copyFile(join(FIXTURES, "session.jsonl"), chatFile);
  await copyFile(join(FIXTURES, "session.jsonl"), jobFile);
  const folder = join(dir, "session-artifacts", DUTY_JOB, "sub-1a2b3c4d");
  await mkdir(folder, { recursive: true });
  await copyFile(join(FIXTURES, "session.jsonl"), join(folder, `${SUBAGENT}.jsonl`));
  await writeFile(join(folder, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId: "sub-1a2b3c4d", sessionName: "fix worker", sessionFile: join(folder, `${SUBAGENT}.jsonl`) }));
  const payload: unknown = JSON.parse(await readFile(join(FIXTURES, "anthropic-payload.json"), "utf8"));
  await recordPrompt(dir, { capturedAt: "2026-10-15T10:00:07.000Z", sessionId: DUTY_JOB, sessionFile: jobFile, provider: "anthropic", model: "claude-opus-5-5", payload });

  const calls: [string, readonly string[] | undefined][] = [];
  const listed = new Map([[CHAT, chatFile]]);
  const backend = {
    prompt: async (id: string, via?: readonly string[]) => {
      calls.push([id, via]);
      const sessionFile = await sessionFileFor(id, { listed: async session => listed.get(session), ...(via ? { via } : {}), dataDir: dir, agentDir: dir });
      return sessionFile ? promptView(id, { sessionFile, dataDir: dir, agentDir: dir, chat: id === CHAT }) : null;
    },
    close: async () => {},
  } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const get = async (path: string) => { const res = await fetch(server.url + path); return { status: res.status, body: await res.json() as PromptView & { error?: string } }; };
  try {
    const job = await get(`api/threads/${DUTY_JOB}/prompt`);
    assert.equal(job.status, 200);
    assert.equal(job.body.origin.kind, "exact", "a duty job's capture in the prompts folder is served though the daemon does not list the job");
    assert.equal(job.body.sessionFile, jobFile);
    assert.deepEqual(job.body.subagents, [{ sessionId: SUBAGENT, name: "fix worker" }]);

    assert.equal((await get(`api/threads/${SUBAGENT}/prompt`)).status, 404, "an ended subagent with no capture is not found by its id alone");
    const child = await get(`api/threads/${SUBAGENT}/prompt?via=${DUTY_JOB}`);
    assert.equal(child.status, 200);
    assert.deepEqual([child.body.threadId, child.body.sessionFile, child.body.origin.kind], [SUBAGENT, join(folder, `${SUBAGENT}.jsonl`), "rebuild"]);

    const chat = await get(`api/threads/${CHAT}/prompt`);
    assert.deepEqual([chat.status, chat.body.sessionFile, chat.body.subagents], [200, chatFile, undefined]);
    assert.equal((await get(`api/threads/${SUBAGENT}/prompt?via=${encodeURIComponent("../etc")}`)).status, 400, "every id in via is checked like the session id");
    assert.deepEqual(calls.map(([id, via]) => [id, via ?? []]), [[DUTY_JOB, []], [SUBAGENT, []], [SUBAGENT, [DUTY_JOB]], [CHAT, []]]);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
