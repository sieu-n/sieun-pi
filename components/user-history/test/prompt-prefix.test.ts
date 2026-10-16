import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Request } from "./prompt-prefix-turns.ts";

const withoutCacheControl = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutCacheControl) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCacheControl(item)])) : value;
const blocks = (message: unknown) => {
  const { role, content } = message as { role: string; content: unknown };
  return withoutCacheControl({ role, content: typeof content === "string" ? [{ type: "text", text: content }] : content });
};

const agentsMd = join(import.meta.dirname, "../../../config/AGENTS.md");

/** Runs test/prompt-prefix-turns.ts in a child process with a clean env and the installed global AGENTS.md, and returns every Anthropic request it serialized. */
type Run = { requests: Request[]; fresh: Request; freshAfterBrief: Request; compacted: Request; rule: string; pending: number };
async function realRequests(): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-prefix-"));
  try {
    await mkdir(join(dir, "agent"), { recursive: true });
    await copyFile(agentsMd, join(dir, "agent", "AGENTS.md"));
    const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "prompt-prefix-turns.ts"), dir], { cwd: join(import.meta.dirname, ".."),
      encoding: "utf8", timeout: 90_000, env: { PATH: process.env.PATH ?? "", HOME: dir, PRIME_AGENT_CODING_AGENT_DIR: join(dir, "agent"), GLOBAL_RULES_LOG: join(dir, "rules.log") } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(await readFile(join(dir, "requests.json"), "utf8")) as Run;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a real chat sends the same cached prefix on owner turns, tool continuations, agent-message wakes, child notices, check-ins, heartbeats, after a correction, after a rate-limited retry, after a reload and after a brief change, and a reloaded chat sends a fresh chat's system prompt and tools", { timeout: 120_000 }, async () => {
  const { requests, fresh, freshAfterBrief, compacted, rule, pending } = await realRequests();
  assert.equal(pending, 0);
  const turns = [...new Set(requests.map(request => request.turn))];
  assert.deepEqual(turns, ["owner", "agent-message wake", "owner again", "child exit notice", "check-in", "heartbeat", "agent message mid-turn",
    "agent-message wake after a correction", "owner after a correction", "owner after a rate-limited call", "tool calls after a correction", "agent-message wake after a reload", "agent-message wake after a brief change"]);
  requests.slice(1).forEach(({ turn, payload }, index) => {
    const previous = requests[index]!.payload;
    const label = `request ${index + 1} (${turn}) after request ${index} (${requests[index]!.turn})`;
    assert.deepEqual(withoutCacheControl(payload.tools), withoutCacheControl(previous.tools), `${label}: the tools changed`);
    assert.deepEqual(withoutCacheControl(payload.system), withoutCacheControl(previous.system), `${label}: the system prompt changed`);
    assert.ok(payload.messages.length > previous.messages.length, `${label}: no new message`);
    payload.messages.slice(0, previous.messages.length).forEach((message, at) =>
      assert.deepEqual(blocks(message), blocks(previous.messages[at]), `${label}: message ${at} of the cached prefix changed`));
  });
  const reloaded = requests.find(request => request.turn === "agent-message wake after a reload")!.payload;
  assert.deepEqual(withoutCacheControl(reloaded.tools), withoutCacheControl(fresh.payload.tools), "a reloaded chat has a fresh chat's tools");
  assert.deepEqual(withoutCacheControl(reloaded.system), withoutCacheControl(fresh.payload.system), "a reloaded chat has a fresh chat's system prompt");
  assert.ok(!JSON.stringify(requests.at(-1)!.payload.system).includes(rule), "a running chat keeps its pinned brief after a brief change");
  for (const [label, { payload }] of [["a chat started after the brief change", freshAfterBrief], ["a compacted chat", compacted]] as const) {
    assert.ok(JSON.stringify(payload.system).includes(rule), `${label} has the new brief in its system prompt`);
    assert.deepEqual(withoutCacheControl(payload.tools), withoutCacheControl(freshAfterBrief.payload.tools), `${label}: a fresh chat's tools`);
  }
  assert.deepEqual(withoutCacheControl(compacted.payload.system), withoutCacheControl(freshAfterBrief.payload.system), "a compacted chat sends a fresh chat's system prompt");
  const rules = (await readFile(agentsMd, "utf8")).trim();
  for (const { turn, payload } of requests) assert.ok(JSON.stringify(payload.system).includes(JSON.stringify(rules).slice(1, -1)), `${turn}: ~/.prime/agent/AGENTS.md is missing from the system prompt`);
});
