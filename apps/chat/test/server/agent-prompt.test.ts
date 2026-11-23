/**
 * `GET /api/agents/:id/prompt` on the fixture host: pi-host's builder in the checkout builds the prompt of each kind of the agent's threads
 * from the fixture's Prime agent dir, with the agent's brief, its role text and the skills the prompt lists.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-prompt.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { builderStarts } from "../../server/agent-prompt.ts";
import type { AgentPrompt } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start({ wordMs: 0 });
});
after(async () => {
  await s.close();
});

const prompt = (id: string) => s.get<AgentPrompt>(`/api/agents/${encodeURIComponent(id)}/prompt`);

test("an agent's prompt has its main thread, comm thread and job kinds, each built by pi-host's code with its sections in order", async () => {
  const p = await prompt(agents.harness);
  assert.equal(p.agent, agents.harness);
  assert.equal(p.away, undefined);
  assert.ok(p.builtBy.length > 0);
  const kinds = p.kinds.map(k => k.kind);
  assert.equal(kinds[0], "work");
  assert.equal(kinds.at(-1), "job");
  const work = p.kinds[0]!;
  assert.equal(work.conversation, 1);
  assert.equal(work.sections[0]!.key, "preamble");
  assert.match(work.sections[0]!.text, /^You are/);
  assert.equal(work.sections.at(-1)!.key, "instructions", "the role text comes last, as pi-durable renders it");
  assert.equal(work.sections.find(sec => sec.key === "harness")?.message, true, "a root's digest goes in as a message");
  const job = p.kinds.at(-1)!;
  assert.ok(job.conversation > 1);
  assert.equal(job.sections.some(sec => sec.key === "instructions"), false, "a job gets no role text");
  assert.equal(job.sections.find(sec => sec.key === "harness")?.message, undefined, "a job's digest is a section");
  assert.match(job.sections.find(sec => sec.key === "preamble")!.text, /Recursive agent depth: 1/);
  for (const skill of p.skills) assert.ok(skill.name && skill.path.endsWith("SKILL.md"));
});

test("calls for one agent that overlap share one build, and an unknown agent is a 404", async () => {
  const [a, b] = await Promise.all([prompt(agents.harness), prompt(agents.harness)]);
  assert.equal(a.builtAt, b.builtAt);
  assert.equal((await s.send("GET", "/api/agents/ag_nobody/prompt")).status, 404);
});

test("a later call builds again in the builder the first call started, and an AGENTS.md changed between calls reaches its answer", async () => {
  const first = await prompt(agents.harness);
  const starts = builderStarts;
  const rules = join(s.app.agents.record(agents.harness)!.home, "AGENTS.md");
  const text = existsSync(rules) ? readFileSync(rules, "utf8") : undefined;
  try {
    writeFileSync(rules, `${text ?? "# Rules\n"}\nThe prompt-tab-speed marker line.\n`);
    const second = await prompt(agents.harness);
    assert.equal(builderStarts, starts, "the second call starts no new builder");
    assert.ok(second.builtAt > first.builtAt, "the second call builds again");
    const context = second.kinds[0]!.sections.find(sec => sec.key === "context")!.text;
    assert.match(context, /The prompt-tab-speed marker line\./);
  } finally {
    if (text === undefined) rmSync(rules);
    else writeFileSync(rules, text);
  }
});
