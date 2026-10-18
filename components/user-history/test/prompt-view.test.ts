import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureFile, readCapture, recordPrompt } from "../src/prompt-capture.ts";
import { estimateTokens, payloadParts, promptView, sessionFileFor, subagentsOf, systemParts, userSource } from "../src/prompt-view.ts";

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
    "user:instructions:[message id]",
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
    const at = (label: string) => view.parts.find(part => part.label === label)?.at;
    assert.deepEqual([at("Owner"), at("Assistant thinking"), at("Assistant tool call"), at("Tool result: ipython"), at("[check-in]"), at("Agent message from ci bot"), at("Harness digest")],
      ["2026-10-15T10:40:01.000Z", "2026-10-15T10:40:03.000Z", "2026-10-15T10:40:03.000Z", "2026-10-15T10:40:04.000Z", "2026-10-15T10:40:06.000Z", "2026-10-15T10:00:05.000Z", "2026-10-15T10:00:00.400Z"],
      "each payload part takes the time of the session message it came from, by tool call id or the opening of its text");
    assert.deepEqual([at("[corrections]"), at("[message id]")], ["2026-10-15T10:00:00.400Z", "2026-10-15T10:40:01.000Z"],
      "a block the context hook adds has no entry of its own and takes the time of the block before it in the same message");
    assert.equal(view.parts.filter(part => !part.role).some(part => part.at), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prompt view: a repeated notice takes each of its times in turn", async () => {
  const { dir, sessionFile } = await scratch();
  try {
    const notice = "[job] Step scan: 1 open step has no live owner.";
    const lines = (await readFile(sessionFile, "utf8")).trimEnd().split("\n");
    lines.push(JSON.stringify({ type: "message", id: "e12", parentId: "e11", timestamp: "2026-10-15T11:00:00.000Z", message: { role: "user", content: [{ type: "text", text: notice }], timestamp: Date.parse("2026-10-15T11:00:00.000Z") } }),
      JSON.stringify({ type: "message", id: "e13", parentId: "e12", timestamp: "2026-10-15T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: notice }], timestamp: Date.parse("2026-10-15T12:00:00.000Z") } }));
    await writeFile(sessionFile, lines.join("\n") + "\n");
    const body = await payload() as { messages: unknown[] };
    body.messages.push({ role: "user", content: [{ type: "text", text: notice }] }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: [{ type: "text", text: notice }] });
    await recordPrompt(dir, { capturedAt: "2026-10-15T12:00:01.000Z", sessionId: SESSION_ID, sessionFile, provider: "anthropic", model: "m", payload: body });
    const view = await promptView(SESSION_ID, { sessionFile, dataDir: dir, chat: true, agentDir: dir });
    assert.deepEqual(view.parts.filter(part => part.text === notice).map(part => part.at), ["2026-10-15T11:00:00.000Z", "2026-10-15T12:00:00.000Z"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prompt view: a job's subagents are listed oldest first, and an ended one the daemon no longer lists opens through its parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-subagents-"));
  try {
    const root = "01a1aaaa-0000-7000-8000-000000000001";
    const rootFile = join(dir, "sessions", `${root}.jsonl`);
    await mkdir(join(dir, "sessions"), { recursive: true });
    await copyFile(join(FIXTURES, "session.jsonl"), rootFile);
    const child = async (folder: string, id: string, name: string): Promise<string> => {
      await mkdir(folder, { recursive: true });
      const file = join(folder, `${id}.jsonl`);
      await copyFile(join(FIXTURES, "session.jsonl"), file);
      await writeFile(join(folder, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId: folder.split("/").at(-1), sessionName: name, sessionFile: file }));
      return file;
    };
    const rootArtifacts = join(dir, "session-artifacts", root);
    await child(join(rootArtifacts, "sub-bbbb"), "01a1cccc-0000-7000-8000-000000000003", "second");
    const first = await child(join(rootArtifacts, "sub-aaaa"), "01a1bbbb-0000-7000-8000-000000000002", "first");
    const grandchild = await child(join(rootArtifacts, "sub-aaaa", "sub-cccc"), "01a1dddd-0000-7000-8000-000000000004", "grandchild");
    await mkdir(join(rootArtifacts, "sub-empty"), { recursive: true });

    assert.deepEqual(await subagentsOf(rootFile, root), [{ sessionId: "01a1bbbb-0000-7000-8000-000000000002", name: "first" }, { sessionId: "01a1cccc-0000-7000-8000-000000000003", name: "second" }]);
    assert.deepEqual(await subagentsOf(first, "01a1bbbb-0000-7000-8000-000000000002"), [{ sessionId: "01a1dddd-0000-7000-8000-000000000004", name: "grandchild" }]);

    const options = { listed: async () => undefined, dataDir: dir, agentDir: dir };
    assert.equal(await sessionFileFor(root, options), rootFile, "a root the daemon does not list opens from Prime's sessions folder");
    assert.equal(await sessionFileFor("01a1dddd-0000-7000-8000-000000000004", options), null);
    assert.equal(await sessionFileFor("01a1dddd-0000-7000-8000-000000000004", { ...options, via: [root, "01a1bbbb-0000-7000-8000-000000000002"] }), grandchild);
    assert.equal(await sessionFileFor("01a1eeee-0000-7000-8000-000000000005", { ...options, via: [root] }), null);
    await recordPrompt(dir, { capturedAt: "2026-10-15T10:00:07.000Z", sessionId: "01a1cccc-0000-7000-8000-000000000003", sessionFile: join(rootArtifacts, "sub-bbbb", "01a1cccc-0000-7000-8000-000000000003.jsonl"), provider: "anthropic", model: "m", payload: await payload() });
    assert.equal(await sessionFileFor("01a1cccc-0000-7000-8000-000000000003", options), join(rootArtifacts, "sub-bbbb", "01a1cccc-0000-7000-8000-000000000003.jsonl"), "a capture names its session file");
    assert.equal(await sessionFileFor(root, { ...options, listed: async () => first }), first, "the daemon's listing comes first");
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
      "message:Assistant thinking",
      "message:Assistant tool call",
      "message:Tool result: ipython",
      "message:Agent message from ci bot",
      "message:[check-in]",
      "message:Assistant",
    ]);
    assert.equal(view.parts[0]!.text, "- This session is a chat. Pinned brief line one.\n- Pinned brief line two.");
    assert.equal(view.measuredInputTokens, 1300);
    assert.equal(view.parts.find(part => part.label === "Owner")?.at, new Date(1792060801000).toISOString(), "a rebuilt part takes its message's time");
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
