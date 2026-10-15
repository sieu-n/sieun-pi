import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import historyExtension from "../extension/index.ts";
import { PERSONA_TOOL, personaGuideline } from "../src/chat-brief.ts";
import { CHAT_MODE_ENTRY } from "../src/chat-guard.ts";
import { systemParts } from "../src/prompt-view.ts";

/** Owner, 10-15 21:10Z: "also i want poteto-mode to be on by default for ALL chat, auto job triggers". */

const fakePi = (dataDir: string) => {
  const tools = new Map<string, { promptGuidelines?: string[] }>();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, appendEntry() {},
    getActiveTools: () => [], setActiveTools() {}, getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined,
  };
  historyExtension(pi as never);
  const emit = async (name: string, event: unknown, ctx: unknown) => {
    let last: unknown;
    for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx) ?? last;
    return last;
  };
  return { tools, emit };
};

test("poteto-mode: a chat, its duty job, a root it started, its subagents at every depth and a duty job's subagent get the line; a plain thread does not", async () => {
  const home = await mkdtemp(join(tmpdir(), "poteto-default-"));
  const skill = join(home, "agent", "skills", "poteto-mode", "SKILL.md");
  await mkdir(join(home, "agent", "skills", "poteto-mode"), { recursive: true });
  await writeFile(skill, "# Poteto mode\n");
  const before = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = join(home, "agent");
  try {
    const dataDir = join(home, "data");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "chat-jobs.json"), JSON.stringify({ jobs: { "s-duty": { chat: "AI harness", at: Date.now() }, "fix sidebar": { chat: "AI harness", at: Date.now() } } }));
    const file = async (name: string, header: object, entries: object[] = []) => {
      const path = join(home, `${name}.jsonl`);
      await writeFile(path, [JSON.stringify({ type: "session", id: `s-${name}`, ...header }), ...entries.map(entry => JSON.stringify(entry))].join("\n") + "\n");
      return path;
    };
    const chatFile = await file("chat", {}, [{ type: "session_info", name: "AI harness" }, { type: "custom", customType: CHAT_MODE_ENTRY }]);
    const jobFile = await file("job", { parentSession: chatFile });
    const dutyFile = await file("duty", {});
    const session = (id: string, name: string, header: object, entries: object[] = []) => ({ sessionManager: { getHeader: () => header,
      getEntries: () => entries, getBranch: () => entries, getSessionId: () => id, getSessionName: () => name } });
    const line = personaGuideline(skill)!;
    const linesOf = async (ctx: ReturnType<typeof session>) => {
      const pi = fakePi(dataDir);
      await pi.emit("session_start", {}, ctx);
      const added = await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx) as { systemPrompt?: string } | undefined;
      return { guidelines: pi.tools.get(PERSONA_TOOL)?.promptGuidelines ?? [], prompt: added?.systemPrompt ?? "base" };
    };
    const chat = await linesOf(session("s-chat", "AI harness", {}, [{ type: "custom", customType: CHAT_MODE_ENTRY }]));
    assert.deepEqual(chat.guidelines, [line], "the chat itself, so check-ins, send-backs and alert wakes in it carry the line");
    assert.deepEqual((await linesOf(session("s-duty", "1016-checkin", {}))).guidelines, [line], "a duty job, registered by its session id");
    assert.deepEqual((await linesOf(session("s-fix", "fix sidebar", {}))).guidelines, [line], "a root the chat started with rlm.create_session");
    assert.deepEqual((await linesOf(session("s-job", "", { rlmDepth: 1, parentSession: chatFile }))).guidelines, [line], "a job the chat spawned");
    assert.deepEqual((await linesOf(session("s-sub", "", { rlmDepth: 2, parentSession: jobFile }))).guidelines, [line], "a job's own subagent");
    assert.deepEqual((await linesOf(session("s-dsub", "", { rlmDepth: 1, parentSession: dutyFile }))).guidelines, [line], "a duty job's subagent");
    const late = await linesOf(session("s-late", "", {}));
    assert.deepEqual(late.guidelines, [], "an unnamed root nobody registered");
    const plain = await linesOf(session("s-plain", "a plain thread", {}));
    assert.deepEqual(plain.guidelines, [], "a plain thread no chat started gets nothing");
    assert.equal(plain.prompt, "base");
  } finally {
    if (before === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR; else process.env.PRIME_AGENT_CODING_AGENT_DIR = before;
  }
});

test("poteto-mode: the line is null when the skill is not installed", () => {
  const skill = "/home/x/.prime/agent/skills/poteto-mode/SKILL.md";
  assert.equal(personaGuideline(skill, path => path === skill), `Work in poteto-mode: read ${skill} before your first step.`);
  assert.equal(personaGuideline(skill, () => false), null);
});

test("poteto-mode: the Prompt view shows the line as its own part, after the chat brief or the job report line", () => {
  const line = "Work in poteto-mode: read /x/SKILL.md before your first step.";
  const job = systemParts(`Base.\n\n# Additional Guidance\n\n- You are a job of the chat AI harness. Report.\n- ${line}\n`, new Set());
  assert.deepEqual(job.map(part => part.label), ["Base system prompt", "Job report line", "poteto-mode line"]);
  const chat = systemParts(`Base.\n\n# Additional Guidance\n\n- A brief line.\n- ${line}\n`, new Set(["A brief line."]));
  assert.deepEqual(chat.map(part => part.label), ["Base system prompt", "Chat brief", "poteto-mode line"]);
});
