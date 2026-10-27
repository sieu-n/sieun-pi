import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";

for (const key of Object.keys(process.env)) if (key.startsWith("RLM_") || key === "PRIME_AGENT_CODING_AGENT_DIR") delete process.env[key];
const root = mkdtempSync(join(tmpdir(), "pi-harness-ext-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const { fauxProvider, openRuntime } = await import("../../test/faux.ts");
const { createHarnessExtension } = await import("../index.ts");
const { kernelHandler } = await import("../../shared/kernel-bridge.ts");
const { readState, updateState } = await import("../src/store.ts");
const { PLANNER_PROMPT, REVIEW_PROMPT } = await import("../src/prompts.ts");

interface Seen { system: string; text: string }

/** Which prompt a model call carries: PLANNER_PROMPT, REVIEW_PROMPT, or the session's own system prompt text. */
function kindOf(context: { systemPrompt?: string; messages: unknown[] }): string {
  const whole = (context.systemPrompt ?? "") + JSON.stringify(context.messages);
  if (whole.includes(JSON.stringify(PLANNER_PROMPT.slice(0, 60)).slice(1, -1))) return PLANNER_PROMPT;
  if (whole.includes(JSON.stringify(REVIEW_PROMPT.slice(0, 60)).slice(1, -1))) return REVIEW_PROMPT;
  return context.systemPrompt ?? "";
}

/** A faux model that answers the planner and the review gate with queued JSON and records what every call saw. */
function scriptedModel() {
  const faux = fauxProvider();
  const seen: Seen[] = [];
  const plans: string[] = [];
  const reviews: string[] = [];
  const respond = (context: { systemPrompt?: string; messages: { role: string; content: unknown }[] }): AssistantMessage => {
    const text = JSON.stringify(context.messages);
    const system = kindOf(context);
    seen.push({ system, text });
    if (system === PLANNER_PROMPT) return fauxAssistantMessage(plans.shift() ?? '{"summary":"nothing","edits":[]}');
    if (system === REVIEW_PROMPT) return fauxAssistantMessage(reviews.shift() ?? '{"shouldRefine":false,"rationale":"no"}');
    return fauxAssistantMessage(`answer ${seen.length} ` + "filler words ".repeat(300));
  };
  faux.core.setResponses(Array.from({ length: 400 }, () => respond as never));
  return { faux, seen, plans, reviews };
}

const memory = (id: string, content: string) => {
  const at = new Date().toISOString();
  return { id, kind: "memory" as const, title: `Title ${id}`, content, path: "general", scope: "global" as const, reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: at, updated_at: at, version: 1 };
};

function sessionEntries(file: string) {
  return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

async function open(name: string, route: "message" | "section", settings: Record<string, unknown> = {}) {
  const dir = join(root, name);
  const globalDir = join(dir, "global-harness");
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ harness: { digestRoute: route }, ...settings }));
  await updateState(globalDir, "global", state => {
    state.entries.memory.alpha = memory("alpha", "alpha content v1");
  });
  const model = scriptedModel();
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const runtime = await openRuntime({ root: dir, provider: model.faux, extensionFactories: [createHarnessExtension({ globalDir })] });
  return { runtime, globalDir, ...model, file: () => runtime.session.sessionManager.getSessionFile()! };
}

before(() => mkdirSync(root, { recursive: true }));
after(() => rmSync(root, { recursive: true, force: true }));

for (const route of ["message", "section"] as const) {
  test(`${route} route: the digest reaches the model, a refine updates it, and it is kept after compaction (P3)`, async () => {
    const h = await open(`p3-${route}`, route, { compaction: { enabled: false, keepRecentTokens: 50 } });
    const { session } = h.runtime;
    await session.prompt("hello there");
    const first = h.seen.at(-1)!;
    const inFirst = first.system + first.text;
    assert.match(inFirst, /# Continual Harness State/);
    assert.match(inFirst, /alpha content v1/);

    h.plans.push(JSON.stringify({ summary: "add beta", rationale: "r", expectedOutcome: "o", edits: [{ action: "create", kind: "memory", id: "beta", title: "Beta", content: "beta content" }] }));
    await session.prompt("/refine --global add beta");
    assert.ok(readState(h.globalDir, "global").entries.memory.beta, "the refine wrote the global store");
    assert.ok(readFileSync(join(h.globalDir, "refinements.jsonl"), "utf8").includes('"beta"'));

    await session.prompt("next question");
    const second = h.seen.at(-1)!;
    if (route === "message") assert.match(second.text, /\[harness-digest update\][\s\S]*beta content/);
    else assert.match(second.text + second.system, /beta content/);

    await session.compact();
    await session.prompt("after compaction");
    const last = h.seen.at(-1)!;
    assert.match(route === "section" ? last.system + last.text : last.text, /beta content/, "the digest is in the first request after compaction");
    const entries = sessionEntries(h.file());
    const types = entries.map(e => e.type + (e.customType ? ":" + e.customType : ""));
    assert.ok(types.includes("custom:prime-agent.refinement"));
    assert.ok(types.includes("custom_message:refinement_outcome"));
    assert.ok(types.includes("custom_message:refinement_notice"));
    if (route === "message") assert.ok(types.filter(t => t === "custom_message:harness_digest").length >= 3);
    else {
      const compaction = entries.find(e => e.type === "compaction");
      assert.match(JSON.stringify(compaction.systemMessage ?? {}), /beta content/, "the compaction entry carries the digest section");
    }
    assert.ok(!h.seen.some(s => s.text.includes("Refinement complete:")), "refinement_outcome stays out of model context and the summarizer");
    const summarizer = h.seen.find(s => s.text.includes("context summarization assistant"));
    assert.ok(summarizer, "the compaction summarizer ran");
    assert.ok(!summarizer.text.includes("[harness-digest"), "digest messages stay out of the summarizer");
    await h.runtime.dispose?.();
  });
}

test("refine.run from the kernel schedules a self refine that applies at the end of the turn and resumes the agent", async () => {
  const h = await open("self", "message");
  const { session } = h.runtime;
  const id = session.sessionManager.getSessionId();
  await session.prompt("warm up");
  const run = kernelHandler(id, "refine.run")!;
  assert.deepEqual(await run({}), { scheduled: false, reason: "no active turn; refine can only be requested while a turn is running" });
  h.plans.push(JSON.stringify({ summary: "local note", edits: [{ action: "create", kind: "memory", id: "gamma", title: "Gamma", content: "gamma local" }] }));
  h.faux.core.setResponses([
    (async () => {
      const answer = await run({ instructions: "remember gamma" });
      assert.equal((answer as { scheduled: boolean }).scheduled, true);
      assert.deepEqual(await kernelHandler(id, "refine.status")!({}), { pending: true, in_flight: false });
      return fauxAssistantMessage("asked for a refine");
    }) as never,
    ...Array.from({ length: 50 }, () => ((context: { systemPrompt?: string; messages: unknown[] }) => {
      const system = kindOf(context);
      h.seen.push({ system, text: JSON.stringify(context.messages) });
      return fauxAssistantMessage(system === PLANNER_PROMPT ? h.plans.shift()! : "resumed");
    }) as never),
  ]);
  await session.prompt("please refine");
  for (let i = 0; i < 100 && !h.seen.some(s => s.text.includes("[self-refinement]")); i++) await new Promise(r => setTimeout(r, 20));
  await session.agent.waitForIdle?.();
  const resumed = h.seen.find(s => s.text.includes("[self-refinement]"));
  assert.ok(resumed, "the agent resumed with the notice");
  assert.match(resumed.text, /gamma local/);
  const local = sessionEntries(h.file()).length;
  assert.ok(local > 0);
  const artifact = join(root, "self", "agent", "session-artifacts", id, "harness");
  assert.ok(readState(artifact, "local").entries.memory.gamma, "the self refine wrote the session's local store");
});

test("auto-refine reviews after the turn interval, applies the planner's edits, and /refine rollback undoes them", async () => {
  const h = await open("auto", "message", { autoRefine: { turnInterval: 2, cooldownMs: 0 } });
  const { session } = h.runtime;
  const id = session.sessionManager.getSessionId();
  h.reviews.push('{"shouldRefine":true,"rationale":"a lesson","instructions":"keep delta"}');
  h.plans.push(JSON.stringify({ summary: "auto note", edits: [{ action: "create", kind: "memory", id: "delta", title: "Delta", content: "delta local" }] }));
  await session.prompt("one");
  assert.equal(h.seen.filter(s => s.system === REVIEW_PROMPT).length, 0);
  await session.prompt("two");
  for (let i = 0; i < 100 && h.seen.filter(s => s.system === PLANNER_PROMPT).length === 0; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 100));
  const planner = h.seen.find(s => s.system === PLANNER_PROMPT)!;
  assert.match(planner.text, /Automatic refine review triggered by turn_interval/);
  const dir = join(root, "auto", "agent", "session-artifacts", id, "harness");
  assert.ok(readState(dir, "local").entries.memory.delta);
  const record = sessionEntries(h.file()).find(e => e.customType === "prime-agent.refinement");
  await session.prompt(`/refine rollback ${record.data.id}`);
  assert.equal(readState(dir, "local").entries.memory.delta, undefined, "rollback deleted the created entry");
  const notices = sessionEntries(h.file()).filter(e => e.customType === "refinement_notice").map(e => e.content);
  assert.match(notices[0], /^\[auto-refinement\]/);
  assert.match(notices[1], /^\[user-refinement\]/);
});
