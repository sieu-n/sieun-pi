/**
 * Archiving a walk's test agent removes its folder from the agents dir, which the wiki mounts as `agents/`, and a real agent keeps its
 * folder on archive (#sw-factory-build p237, "agents folder full of slop clean up").
 * Run: TMPDIR=/tmp/<short> node apps/chat/scripts/spec-clean.mjs -- node --test --test-force-exit --test-isolation=none test/server/test-agent-folder.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

/** Makes an agent, gives its folder a page as a job's wiki write would, archives it and answers its folder. */
async function archived(name: string, testAgent: boolean): Promise<string> {
  const agent = (await s.send<AgentSummary & { thread: string }>("POST", "/api/agents", { name, ...(testAgent ? { test: true } : {}) })).body;
  const record = s.app.agents.record(agent.id)!;
  const dir = join(s.app.config.agentsDir, record.slug);
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, "work", "notes.html"), "<h1>notes</h1>");
  assert.equal((await s.send("PATCH", `/api/c/${agent.thread}`, { archived: true })).status, 200);
  await until(async () => s.app.agents.record(agent.id)?.archived, Boolean);
  return dir;
}

test("archiving a test agent removes its folder from the agents dir", async () => {
  const dir = await archived("blind folder probe", true);
  assert.equal(existsSync(dir), false);
});

test("archiving a real agent keeps its folder", async () => {
  const dir = await archived("real folder probe", false);
  assert.equal(existsSync(join(dir, "work", "notes.html")), true);
});
