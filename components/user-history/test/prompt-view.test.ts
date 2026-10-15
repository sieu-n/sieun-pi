import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureFile, readCapture, recordPrompt } from "../src/prompt-capture.ts";
import { estimateTokens, payloadParts, promptView, systemParts, userSource } from "../src/prompt-view.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "prompt-view");
const SESSION_ID = "01a1fixt-0000-7000-8000-000000000001";
const payload = async (): Promise<unknown> => JSON.parse(await readFile(join(FIXTURES, "anthropic-payload.json"), "utf8"));

async function scratch(): Promise<{ dir: string; sessionFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-view-"));
  const sessionFile = join(dir, `${SESSION_ID}.jsonl`);
  await copyFile(join(FIXTURES, "session.jsonl"), sessionFile);
  return { dir, sessionFile };
}

test("prompt view: the system prompt splits at Prime's section headings, in payload order", async () => {
  const parts = payloadParts(await payload());
  const head = parts.filter(part => part.kind !== "message" && part.role === undefined).map(part => `${part.kind}:${part.label}`);
  assert.deepEqual(head, [
    "system:Provider identity line", "system:Base system prompt", "system:Subagent guidance", "system:MCP connections", "instructions:Chat brief",
    "instructions:/home/owner/.prime/agent/AGENTS.md", "instructions:/work/repo/AGENTS.md", "skills:Skills list",
    "tools:Tool: ipython", "tools:Tool: chat_board",
  ]);
  const agents = parts.find(part => part.label === "/home/owner/.prime/agent/AGENTS.md")!;
  assert.match(agents.text, /^# Project Context\n/);
  assert.match(agents.text, /## Writing\n\nFollow unslop\./, "a heading inside an AGENTS.md stays in its file");
  const brief = parts.find(part => part.label === "Chat brief")!;
  assert.match(brief.text, /An older pinned line\./, "a pinned brief line that CHAT_BRIEF no longer has still reads as the brief");
  assert.equal(parts.find(part => part.kind === "tools")!.text.includes('"required"'), true);
});

test("prompt view: every message part names its source", async () => {
  const parts = payloadParts(await payload()).filter(part => part.role !== undefined);
  assert.deepEqual(parts.map(part => `${part.role}:${part.kind}:${part.label}`), [
    "user:harness:Harness digest",
    "user:instructions:[corrections]",
    "user:message:Owner",
    "user:instructions:[reply cap]",
    "assistant:message:Assistant thinking",
    "assistant:message:Assistant tool call",
    "toolResult:message:Tool result: ipython",
    "user:message:[check-in]",
    "user:message:Agent message from ci bot",
    "user:message:[board] owner action",
    "user:message:[job] notice",
    "user:message:[brief check]",
  ]);
  const call = parts.find(part => part.label === "Assistant tool call")!;
  assert.equal(call.text, "Looking.\n\n→ ipython\nprint(open('deploy.log').read())");
});

test("prompt view: server notes, Prime notices and owner text are told apart by their opening", () => {
  assert.equal(userSource("[board] Ops not applied: p3").label, "[board] server note");
  assert.equal(userSource("[task from parent]\n\nDo it.").label, "Agent message: task from parent");
  assert.equal(userSource("[auto-refinement] Refinement saved: x").kind, "harness");
  assert.equal(userSource("<prime_agent_worker_interrupted>\nThe worker stopped.").label, "Prime notice: worker interrupted");
  assert.equal(userSource("[reply check] Your last owner reply had: a dash.").label, "[reply check]");
  assert.equal(userSource("[from crawler vp] your step p4 is stale").label, "Nudge for crawler vp");
  assert.equal(userSource("ship it").label, "Owner");
});

test("prompt view: a prompt with no Prime headings is one base part", () => {
  assert.deepEqual(systemParts("You are helpful.").map(part => part.label), ["Base system prompt"]);
});

test("prompt view: OpenAI Responses payloads read instructions, tools and input items", () => {
  const parts = payloadParts({
    instructions: "Base.\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /work/AGENTS.md\n\nRules.\n\n",
    tools: [{ type: "function", name: "ipython", description: "Run Python.", parameters: { type: "object" } }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "[check-in] Open steps: 1." }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Think." }], encrypted_content: "x" },
      { type: "function_call", call_id: "c1", name: "ipython", arguments: "{\"code\":\"1+1\"}" },
      { type: "function_call_output", call_id: "c1", output: "2" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Two." }] },
    ],
  });
  assert.deepEqual(parts.map(part => part.label), ["Base system prompt", "/work/AGENTS.md", "Tool: ipython", "[check-in]", "Assistant thinking",
    "Assistant tool call", "Tool result: ipython", "Assistant"]);
});

test("prompt view: with a capture the origin is exact and the provider's count of the last call comes from the session file", async () => {
  const { dir, sessionFile } = await scratch();
  try {
    await recordPrompt(dir, { capturedAt: "2026-10-15T10:00:07.000Z", sessionId: SESSION_ID, sessionFile, provider: "anthropic", model: "claude-opus-5-5", payload: await payload() });
    const view = await promptView(SESSION_ID, { sessionFile, dataDir: dir, chat: true, agentDir: dir });
    assert.deepEqual(view.origin, { kind: "exact", capturedAt: "2026-10-15T10:00:07.000Z", provider: "anthropic", model: "claude-opus-5-5" });
    assert.equal(view.measuredInputTokens, 5 + 1200 + 95);
    assert.equal(view.totalTokens, view.parts.reduce((sum, part) => sum + part.tokens, 0));
    assert.deepEqual(view.parts.map(part => part.id), view.parts.map((_, index) => `p${index}`));
    const owner = view.parts.find(part => part.label === "Owner")!;
    assert.equal(owner.tokens, estimateTokens("can you check the deploy?"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prompt view: without a capture it rebuilds from the session file and names what is missing", async () => {
  const { dir, sessionFile } = await scratch();
  try {
    const view = await promptView(SESSION_ID, { sessionFile, dataDir: dir, chat: true, agentDir: dir });
    assert.equal(view.origin.kind, "rebuild");
    assert.match(view.origin.kind === "rebuild" ? view.origin.reason : "", /missing: the base system prompt/);
    assert.deepEqual(view.parts.map(part => `${part.kind}:${part.label}`), [
      "instructions:Chat brief",
      "harness:Harness digest",
      "instructions:[corrections]",
      "message:Owner",
      "instructions:[message id]",
      "instructions:[reply cap]",
      "message:Assistant thinking",
      "message:Assistant tool call",
      "message:Tool result: ipython",
      "message:Agent message from ci bot",
      "message:[check-in]",
      "message:Assistant",
    ]);
    assert.equal(view.parts[0]!.text, "- This session is a chat. Pinned brief line one.\n- Pinned brief line two.");
    assert.equal(view.measuredInputTokens, 1300);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prompt capture: the newest write wins, no temp file is left, and a capture of another session is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-capture-"));
  try {
    const base = { sessionId: SESSION_ID, sessionFile: null, provider: "anthropic", model: "m" };
    const first = recordPrompt(dir, { ...base, capturedAt: "2026-10-15T10:00:00.000Z", payload: { n: 1, big: "x".repeat(2_000_000) } });
    const second = recordPrompt(dir, { ...base, capturedAt: "2026-10-15T10:00:01.000Z", payload: { n: 2 } });
    await Promise.all([first, second]);
    assert.deepEqual((await readCapture(dir, SESSION_ID))?.payload, { n: 2 });
    assert.deepEqual(await readdir(join(dir, "prompts")), [`${SESSION_ID}.json`]);
    await mkdir(join(dir, "prompts"), { recursive: true });
    await copyFile(captureFile(dir, SESSION_ID), captureFile(dir, "other"));
    assert.equal(await readCapture(dir, "other"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
