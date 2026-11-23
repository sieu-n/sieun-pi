/**
 * `GET /api/agents/:id/prompt` on the fixture host: pi-host's builder in the checkout builds the prompt of each kind of the agent's threads
 * from the fixture's Prime agent dir, with the agent's brief, its role text and the skills the prompt lists.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-prompt.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { builderStarts, forgetPrompts, promptBuilds } from "../../server/agent-prompt.ts";
import { flushSync } from "../../server/disk.ts";
import type { AgentPrompt, AgentPromptOutline } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
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

test("an outline read builds again in the builder the first call started, and an AGENTS.md changed between reads reaches the whole answer", async () => {
  const first = await prompt(agents.harness);
  const starts = builderStarts;
  const outline = () => s.get<AgentPromptOutline>(`/api/agents/${encodeURIComponent(agents.harness)}/prompt/outline`);
  const rules = join(s.app.agents.record(agents.harness)!.home, "AGENTS.md");
  const text = existsSync(rules) ? readFileSync(rules, "utf8") : undefined;
  try {
    writeFileSync(rules, `${text ?? "# Rules\n"}\nThe prompt-tab-speed marker line.\n`);
    const built = promptBuilds;
    await outline();
    assert.equal(promptBuilds, built + 1, "the outline read builds");
    const second = await prompt(agents.harness);
    assert.equal(promptBuilds, built + 1, "the whole answer after it takes that build's texts and builds no more");
    assert.equal(builderStarts, starts, "the second call starts no new builder");
    assert.ok(second.builtAt > first.builtAt, "the second call builds again");
    const context = second.kinds[0]!.sections.find(sec => sec.key === "context")!.text;
    assert.match(context, /The prompt-tab-speed marker line\./);
    await outline();
    const third = await prompt(agents.harness);
    assert.equal(builderStarts, starts, "the third call starts no new builder");
    assert.equal(third.builtAt, second.builtAt, "a build that made the same text answers with the time that text was first built");
  } finally {
    if (text === undefined) rmSync(rules);
    else writeFileSync(rules, text);
  }
});

test("a root job filed under an agent shows as one job, with no role text", async () => {
  const p = await prompt(ids.cutover);
  assert.deepEqual(p.kinds.map(k => [k.kind, k.conversation]), [["job", 1]]);
  assert.equal(p.kinds[0]!.sections.some(sec => sec.key === "instructions"), false);
});

test("a page that holds the newest answer gets 304 with no body", async () => {
  const path = `/api/agents/${encodeURIComponent(agents.harness)}/prompt`;
  const first = await fetch(s.base + path, { headers: { "accept-encoding": "br" } });
  const etag = first.headers.get("etag");
  assert.ok(etag, "the answer carries an ETag");
  await first.arrayBuffer();
  const again = await fetch(s.base + path, { headers: { "accept-encoding": "br", "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
});

test("the outline lists each section's key, source and size with no text, of the same build as the whole answer", async () => {
  const outline = await s.get<AgentPromptOutline>(`/api/agents/${encodeURIComponent(agents.harness)}/prompt/outline`);
  const whole = await prompt(agents.harness);
  assert.equal(outline.builtAt, whole.builtAt);
  assert.deepEqual(outline.kinds.map(k => k.sections.map(sec => [sec.key, sec.chars])), whole.kinds.map(k => k.sections.map(sec => [sec.key, sec.text.length])));
  assert.equal(outline.kinds.some(k => k.sections.some(sec => "text" in sec)), false);
  assert.deepEqual(outline.skills, whole.skills);
});

test("after a restart an outline read answers at once from the stored answer, marked pending, and ?wait=1 brings the build it started", async () => {
  const path = `/api/agents/${encodeURIComponent(agents.harness)}/prompt/outline`;
  const built = await s.get<AgentPromptOutline>(path);
  flushSync();
  forgetPrompts();
  const asked = performance.now();
  const stored = await s.get<AgentPromptOutline>(path);
  const ms = performance.now() - asked;
  assert.equal(stored.pending, true);
  assert.equal(stored.builtAt, built.builtAt);
  assert.ok(ms < 1_000, `the stored answer came in ${Math.round(ms)} ms, while a new builder's first build takes about 3 s`);
  const whole = await prompt(agents.harness);
  assert.equal(whole.builtAt, built.builtAt, "the whole answer of the stored build comes with it");
  const fresh = await s.get<AgentPromptOutline>(`${path}?wait=1`);
  assert.equal(fresh.pending, undefined);
  assert.equal(fresh.builtAt, built.builtAt, "the same text keeps the time it was first built across the restart");
});
