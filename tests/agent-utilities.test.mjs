import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectAgentIdentity } from "../utils/agent-identity.mjs";
import { derivePrimeAgent } from "../utils/prime-context.mjs";

test("Prime identity uses the stable session directory rather than a worker id", () => {
  assert.deepEqual(detectAgentIdentity({ RLM_SESSION_DIR: "/fixture/session-a", PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "worker-b" }),
    { agentId: "prime-agent", sessionId: "session-a" });
});
test("Prime identity accepts a worker id when no session directory exists", () => {
  assert.deepEqual(detectAgentIdentity({ PI_CODING_AGENT: "1", PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "worker-b" }),
    { agentId: "prime-agent", sessionId: "worker-b" });
});
test("Codex and Claude identity remain available to shared callers", () => {
  assert.deepEqual(detectAgentIdentity({ CODEX_THREAD_ID: "codex-a" }), { agentId: "codex", sessionId: "codex-a" });
  assert.deepEqual(detectAgentIdentity({ CLAUDECODE: "1", CLAUDE_SESSION_ID: "claude-a" }), { agentId: "claude", sessionId: "claude-a" });
});
test("unidentified callers do not receive an invented host or session", () => {
  assert.deepEqual(detectAgentIdentity({}), { agentId: "unknown", sessionId: null });
});
test("native skill derivation preserves precedence and explicit repository keys", async (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "sieun-pi-context-"));
  const home = path.join(fixture, "home");
  const repo = path.join(fixture, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fixture, { recursive: true, force: true });
  });
  const add = (base, name, description, hidden = false) => {
    const directory = path.join(base, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${hidden}\n---\nFixture body.\n`);
  };
  add(path.join(repo, ".prime/agent/skills"), "fixture-dupe", "Project wins", true);
  add(path.join(repo, ".agents/skills"), "fixture-dupe", "Ancestor loses");
  add(path.join(home, ".prime/agent/skills"), "fixture-user", "User skill");
  const { rows } = await derivePrimeAgent(repo, { repoRoot: repo });
  const duplicate = rows.filter(row => row.name === "fixture-dupe");
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].description, "Project wins");
  assert.equal(duplicate[0].visible, false);
  assert.equal(duplicate[0].skill_key, "repo:.prime/agent/skills/fixture-dupe/SKILL.md");
  assert.equal(rows.find(row => row.name === "fixture-user").skill_key, "home:.prime/agent/skills/fixture-user/SKILL.md");
  assert(rows.some(row => row.root_kind === "builtin"));
});
