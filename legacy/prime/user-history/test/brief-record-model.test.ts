// Guards the brief keeper's restart model (w81, 10-26). A spawn that names no model or thinking inherits the chat's: the daemon resolves the
// model, and the child runs at the chat's thinking level. The record of such a spawn held neither, so the keeper's restart of a child that
// never became a session (chat-backend.ts, dutyJobs.start with recordModel) ran on the daemon's default model and thinking instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEFS_DIR, recordModel } from "../src/brief-keeper.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const CHAT = "01a17752-e6b6-7593-a889-aed2e6884c4a";
const JOB = "01a17754-6d54-76d5-b854-855ffa4925f4";
const CS = "create" + "_session";
const line = (entry: Record<string, unknown>) => JSON.stringify({ id: "x", parentId: null, timestamp: "2026-10-26T08:28:41.000Z", ...entry });

/**
 * A kernel with the wrapper over a fake rlm whose host answers like Prime 0.9.8: each reply names the model the daemon resolved. `session`
 * is the kernel's own: the chat (a root) or a job of it (a subagent), whose session file sets thinking high and then medium.
 */
async function kernel(session: "root" | "child", calls: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "brief-record-model-"));
  const agentDir = join(dir, "agent");
  const own = session === "root" ? join(agentDir, "session-artifacts", CHAT) : join(agentDir, "session-artifacts", CHAT, "sub-868db11d");
  await mkdir(own, { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  const file = session === "root" ? join(agentDir, "sessions", `${CHAT}.jsonl`) : join(own, `${JOB}.jsonl`);
  await writeFile(file, [
    line({ type: "session", version: 3, id: session === "root" ? CHAT : JOB, cwd: dir }),
    line({ type: "model_change", provider: "openai-codex", modelId: "gpt-6-astra" }),
    line({ type: "thinking_level_change", thinkingLevel: "high" }),
    ...Array.from({ length: 3_000 }, (_, i) => line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `turn ${i} ${"x".repeat(40)}` }] } })),
    line({ type: "thinking_level_change", thinkingLevel: "medium" }),
    line({ type: "message", message: { role: "user", content: "next" } }),
  ].join("\n") + "\n");
  const art = join(agentDir, "session-artifacts", CHAT, "sub-aede9b4e");
  await writeFile(join(dir, "rlm.py"), [
    "class repl:",
    "    @staticmethod",
    "    def emit(data): pass",
    "async def host_request(request_type, payload=None):",
    "    kw = payload['kwargs']",
    "    model = kw.get('model') or 'openai-codex/gpt-6-astra'",
    `    if request_type == 'rlm.run': return {'rlm_child_id': kw['name'], 'name': kw['name'], 'session_dir': ${JSON.stringify(art)}, 'model': model}`,
    "    return {'active_session_id': '01a1422b-0000-7000-8000-000000000001', 'session_id': '01a1422b-0000-7000-8000-000000000001', 'name': kw['name'], 'session_file': '/s/01a1422b.jsonl', 'model': model}",
    "async def spawn(prompt, name, model=None, thinking=None):",
    "    kw = {'name': name, **({'model': model} if model else {}), **({'thinking': thinking} if thinking else {})}",
    "    return await host_request('rlm.run', {'prompt': prompt, 'kwargs': kw})",
    `async def ${CS}(prompt, name=None):`,
    `    return await host_request('rlm.${CS}', {'prompt': prompt, 'kwargs': {'name': name}})`,
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + ["import asyncio, rlm", "async def main():", ...calls.map(call => `    await ${call}`), "asyncio.run(main())"].join("\n");
  const run = spawnSync("python3", ["-c", script], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: own, PRIME_AGENT_CODING_AGENT_DIR: agentDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json") } });
  assert.equal(run.status, 0, String(run.stderr));
  const read = async (name: string) => JSON.parse(await readFile(join(dir, BRIEFS_DIR, name), "utf8"));
  return { dir, read };
}

test("a spawn that names no model or thinking records the model the daemon resolved and the chat's thinking now, so a restart runs on them", async () => {
  const { dir, read } = await kernel("root", [
    "rlm.spawn('count the test files', name='sub-a1')",
    `rlm.${CS}('count the test files as a root', name='count root')`,
    "rlm.spawn('count on another model', name='sub-a2', model='anthropic/claude-opus-5-5', thinking='low')",
  ]);
  try {
    const child = await read("child-sub-a1.json");
    assert.deepEqual([child.model, child.thinking], ["openai-codex/gpt-6-astra", "medium"], "the chat's last thinking_level_change, past 3,000 lines");
    assert.deepEqual(recordModel(child), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "medium" });
    const root = await read("root-01a1422b-0000-7000-8000-000000000001.json");
    assert.deepEqual(recordModel(root), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "medium" });
    const named = await read("child-sub-a2.json");
    assert.deepEqual(recordModel(named), { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "low" }, "a named model and thinking stay as named");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a job's own spawn records the job's thinking from its session file in its folder", async () => {
  const { dir, read } = await kernel("child", ["rlm.spawn('recount', name='sub-b1')"]);
  try {
    assert.deepEqual(recordModel(await read("child-sub-b1.json")), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "medium" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
