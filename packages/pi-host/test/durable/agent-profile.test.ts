/**
 * A thread that belongs to an agent (an `agent.ref` doc in its root conversation) loads the agent's folder the way Prime loads its own
 * files: the brief is one more Prime context file in "# Project Context", after the AGENTS.md files and behind Prime's preamble, an edit
 * reaches the next request as a new context section alone, and the agent's harness store is the local store of the root's digest and of a
 * child conversation's harness section. A thread with no ref, or a ref of a bad shape, keeps its own store and no brief.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { PRIME_BASE_PROMPT } from "@sieun-pi/pi-family/preamble";
import { CHAT_BRIEF } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { agentHarnessDir, briefFile, conversationHarnessDir, parseAgentRef } from "../../src/durable/agent-profile.ts";
import { threadHarnessDir } from "../../src/durable/prime-harness.ts";
import { primeModules, primePromptParts, primeResources } from "../../src/durable/prime-prompt.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-agent-profile-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

/** The fixture agent dir, a repo cwd with its AGENTS.md, an empty bundled skills folder, and agent `vent`'s folder with a brief and a memory. */
function fixture(name: string) {
  const root = join(dir, name);
  const agentDir = join(root, "agent");
  cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "# Repo rules\n\nRun npm test before a commit.\n");
  const bundled = join(root, "bundled");
  mkdirSync(bundled);
  const folder = join(root, "agents", "vent");
  mkdirSync(join(folder, "harness"), { recursive: true });
  writeFileSync(join(folder, "brief.md"), "# Vent\n\nYou own the vent crawler and its daily report.\n");
  const memory = { id: "vent_quota", kind: "memory", title: "Vent quota", content: "The vent crawler stops at 500 reads a day.", path: "general", scope: "local",
    reference: {}, arguments: {}, metadata: {}, source: "owner", created_at: "2026-10-29T00:00:00+00:00", updated_at: "2026-10-29T00:00:00+00:00", version: 1 };
  writeFileSync(join(folder, "harness", "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { vent_quota: memory }, skill: {}, subagent: {} }, refinements: [] }, null, 2));
  return { agentDir, cwd, bundled, ledgerDir: join(agentDir, "browser-chat"), folder, ref: { agent: "ag_vent", dir: folder, role: "work" as const } };
}

const systemEntries = (entries: readonly EntryRecord[]) => entries.filter(entry => entry.kind === "pi.system").map(entry => (entry.model?.[0] as { sections?: Record<string, string | null> }).sections ?? {});
const userTexts = (messages: readonly Message[]) => messages.filter(message => message.role === "user").map(message => textOf(message.content));

/** One DurableThreads on the fixture whose faux model records each request, and answers `delegate` with a subagent call. */
function threadsOn(f: ReturnType<typeof fixture>, name: string) {
  const roots: Message[][] = [];
  const children: Message[][] = [];
  const respond = ({ messages }: { messages: Message[] }) => {
    if (userTexts(messages).some(text => text.includes("child task"))) {
      children.push(messages);
      return fauxAssistantMessage("child answer");
    }
    roots.push(messages);
    const last = textOf([...messages].reverse().find(m => m.role === "user")?.content ?? "");
    if (last === "delegate" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("subagent", { task: "child task" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("ok");
  };
  const threads = new DurableThreads({
    dir: join(dir, name, "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 20 }, () => respond));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: f.cwd,
    prompt: { agentDir: f.agentDir, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir },
  });
  const ask = async (id: string, text: string) => {
    const { submission } = await threads.submit(id, { text });
    assert.equal((await threads.wait(id, submission)).status, "done");
  };
  const systems = async (id: string, conversation?: number) => systemEntries((await threads.entries(id, { after: 0, limit: 500, ...(conversation ? { conversation } : {}) })).entries);
  return { threads, roots, children, ask, systems };
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("an agent.ref value reads as an agent only in its exact shape", () => {
  assert.deepEqual(parseAgentRef({ agent: "ag_vent", dir: "/a/vent", role: "job" }), { agent: "ag_vent", dir: "/a/vent", role: "job" });
  for (const bad of [null, "ag_vent", [], { agent: "", dir: "/a", role: "work" }, { agent: "a", dir: "relative", role: "work" }, { agent: "a", dir: "/a", role: "boss" }, { agent: "a", role: "work" }]) {
    assert.equal(parseAgentRef(bad), undefined, JSON.stringify(bad));
  }
  const file = "/d/threads/t.sqlite";
  assert.equal(conversationHarnessDir({ id: "t", file }, 1, undefined), threadHarnessDir(file, "t"));
  assert.equal(conversationHarnessDir({ id: "t", file }, 3, undefined), threadHarnessDir(file, "t-3"));
  assert.equal(conversationHarnessDir({ id: "t", file }, 3, { agent: "a", dir: "/a/vent", role: "work" }), "/a/vent/harness");
});

test("an agent thread gets Prime's preamble first, the brief after the AGENTS.md files, and the agent's memory in its digest", async () => {
  const f = fixture("first");
  const { threads, roots, ask, systems } = threadsOn(f, "first");
  try {
    const thread = await threads.create({ name: "vent" });
    await threads.docPut(thread.id, "agent.ref", f.ref);
    await ask(thread.id, "how many reads a day?");
    const prompt = getCurrentSystemPrompt(roots[0]!);
    assert.ok(prompt.startsWith(`${PRIME_BASE_PROMPT}\n\n`), "Prime's preamble opens the prompt");
    const brief = join(f.folder, "brief.md");
    const [context] = (await systems(thread.id)).map(sections => sections.context);
    assert.equal(context, `# Project Context\n\nProject-specific instructions and guidelines:\n\n## ${join(f.agentDir, "AGENTS.md")}\n\n# Rules for every fixture session\n\n1. Read the unslop skill before your first prose.\n\n\n` +
      `## ${join(f.cwd, "AGENTS.md")}\n\n# Repo rules\n\nRun npm test before a commit.\n\n\n## ${brief}\n\n# Vent\n\nYou own the vent crawler and its daily report.\n\n\n`);

    const prime = await primeModules();
    const loader = new prime.DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, bundledSkillsDir: f.bundled, noExtensions: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: threads.fileOf(thread.id), depth: 0, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, agentBrief: briefFile(f.ref)!, primeOnly: true });
    const built = prime.buildSystemPrompt({ cwd: f.cwd, messagesPath: threads.fileOf(thread.id), skills: (await primeResources(f.agentDir, f.cwd, f.bundled)).skills, contextFiles: [...loader.getAgentsFiles().agentsFiles, { path: brief, content: "# Vent\n\nYou own the vent crawler and its daily report.\n" }],
      selectedTools: ["ipython", "search_history", "chat_board", "tell_owner", "correction_add", "poteto_mode"], promptGuidelines: [...CHAT_BRIEF, `Work in poteto-mode: read ${join(f.agentDir, "skills/poteto-mode/SKILL.md")} before your first step.`],
      allowRecursion: true, rlmDepth: 0, genericMcpServers: ["aside"] });
    assert.equal(parts.map(part => part.text).join("\n\n"), built);
    assert.ok(prompt.startsWith(built), "the thread sends Prime's builder's string, then the rules and corrections");

    const [digest, input] = userTexts(roots[0]!);
    assert.match(digest!, /^\[harness-digest\]\n/);
    assert.match(digest!, /- \[local:vent_quota\] Vent quota \(general, v1\): The vent crawler stops at 500 reads a day\./);
    assert.match(digest!, /- \[global:fixture_memory\] /, "the global store still merges under the agent's");
    assert.equal(input, "how many reads a day?");
  } finally {
    await threads.shutdown();
  }
});

test("a brief edit sends only a new context section, an unchanged brief sends nothing, and a child gets the brief and the agent's store", async () => {
  const f = fixture("edit");
  const { threads, roots, children, ask, systems } = threadsOn(f, "edit");
  try {
    const thread = await threads.create({ name: "vent" });
    await threads.docPut(thread.id, "agent.ref", f.ref);
    await ask(thread.id, "first");
    await ask(thread.id, "second");
    let entries = await systems(thread.id);
    assert.equal(entries.length, 1, "an unchanged brief writes no new system entry");
    assert.equal(getCurrentSystemPrompt(roots[1]!), getCurrentSystemPrompt(roots[0]!));

    writeFileSync(join(f.folder, "brief.md"), "# Vent\n\nYou own the vent crawler, its daily report and its alerts.\n");
    await ask(thread.id, "third");
    entries = await systems(thread.id);
    assert.equal(entries.length, 2);
    assert.deepEqual(Object.keys(entries[1]!), ["context"], "only the context section changes");
    assert.match(entries[1]!.context!, /You own the vent crawler, its daily report and its alerts\.\n\n\n$/);
    const first = (messages: Message[]) => getSystemMessageText(messages[0] as Parameters<typeof getSystemMessageText>[0]);
    assert.equal(first(roots[2]!), first(roots[0]!), "the first system message, the cached prefix, is unchanged");

    await ask(thread.id, "delegate");
    const child = await until("the child's request", () => children[0]);
    const prompt = getCurrentSystemPrompt(child);
    assert.match(prompt, /Recursive agent depth: 1\n/);
    assert.ok(prompt.includes(`## ${join(f.folder, "brief.md")}\n\n# Vent\n\nYou own the vent crawler, its daily report and its alerts.\n`), "the child reads the brief");
    assert.match(prompt, /\[harness-digest\][\s\S]*- \[local:vent_quota\] Vent quota/, "the child's harness section merges the agent's store");
    assert.equal(agentHarnessDir(f.ref), join(f.folder, "harness"));
  } finally {
    await threads.shutdown();
  }
});

test("a thread with no agent.ref, or a bad one, keeps its own store and Prime's prompt with no brief", async () => {
  const f = fixture("none");
  const { threads, roots, ask } = threadsOn(f, "none");
  try {
    const plain = await threads.create({ name: "plain" });
    const bad = await threads.create({ name: "bad" });
    await threads.docPut(bad.id, "agent.ref", { agent: "ag_vent", dir: "vent", role: "work" });
    for (const thread of [plain, bad]) {
      const local = threadHarnessDir(threads.fileOf(thread.id), thread.id);
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { own_note: { id: "own_note", kind: "memory", title: "Own note", content: "This thread's own store.", path: "general", scope: "local", version: 1, created_at: "2026-10-29T00:00:00+00:00", updated_at: "2026-10-29T00:00:00+00:00" } }, skill: {}, subagent: {} }, refinements: [] }));
      const at = roots.length;
      await ask(thread.id, "first");
      const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: threads.fileOf(thread.id), depth: 0, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, skip: new Set(["harness"]) });
      assert.equal(getCurrentSystemPrompt(roots[at]!), parts.map(part => part.text).join("\n\n"), "the prompt is the one a thread had before agents");
      assert.doesNotMatch(getCurrentSystemPrompt(roots[at]!), /vent crawler/);
      const [digest] = userTexts(roots[at]!);
      assert.match(digest!, /- \[local:own_note\] Own note/);
      assert.doesNotMatch(digest!, /vent_quota/);
    }
  } finally {
    await threads.shutdown();
  }
});
