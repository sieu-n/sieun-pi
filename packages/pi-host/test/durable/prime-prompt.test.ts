/**
 * A durable thread's system prompt is a Prime chat's: built from a fixture agent dir, its sections come in Prime's order, the Prime part is
 * byte for byte what prime-agent's own `buildSystemPrompt` returns for the same skills, AGENTS.md files and guidelines, a turn with unchanged
 * files sends no new system entry, a changed AGENTS.md sends only its section while the pinned brief and corrections stay, and a thread's
 * root conversation gets the harness digest as a message before its input, as Prime sends it, and no `harness` section.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CHAT_BRIEF, jobReplyGuideline } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { PRIME_BASE_PROMPT } from "@sieun-pi/pi-family/preamble";
import { EXTRA_SECTIONS, PRIME_SECTIONS, primeModules, primePromptParts, primeSystemPrompt } from "../../src/durable/prime-prompt.ts";
import { threadRegistry } from "../../src/durable/registry.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-prime-prompt-"));
after(() => rmSync(dir, { recursive: true, force: true }));
// Prime's loader also reads ~/.agents/skills; an empty home keeps this box's own skills out of the fixture's prompt.
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

/** A copy of the fixture agent dir, a repo cwd with its own AGENTS.md and an unscoped .claude rule, and an empty bundled skills folder. */
function fixture(name: string) {
  const root = join(dir, name);
  const agentDir = join(root, "agent");
  cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".claude", "rules"), { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "# Repo rules\n\nRun npm test before a commit.\n");
  writeFileSync(join(cwd, ".claude", "rules", "always.md"), "Always name the file you changed.\n");
  const bundled = join(root, "bundled");
  mkdirSync(bundled);
  return { agentDir, cwd, bundled, ledgerDir: join(agentDir, "browser-chat") };
}

/** The fixture's skills in directory order, the order a Prime (Bun) binary lists them in. */
function directoryOrder(skillsDir: string): string[] {
  const handle = opendirSync(skillsDir);
  const names: string[] = [];
  for (let entry = handle.readSync(); entry; entry = handle.readSync()) names.push(entry.name);
  handle.closeSync();
  return names.map(name => join(skillsDir, name, "SKILL.md"));
}

test("the sections come in Prime's order, each with its source's text", async () => {
  const f = fixture("order");
  const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: "/threads/t.sqlite", depth: 0, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir });
  assert.deepEqual(parts.map(part => part.key), [...PRIME_SECTIONS, ...EXTRA_SECTIONS]);
  const text = Object.fromEntries(parts.map(part => [part.key, part.text]));
  assert.ok(text.preamble!.startsWith(`${PRIME_BASE_PROMPT}\n\n`), "Prime's preamble opens the prompt, as Anthropic needs for a subscription token");
  assert.match(text.preamble!, new RegExp(`Working directory: ${f.cwd}\nConversation log: /threads/t.sqlite\nRecursive agent depth: 0\n`));
  assert.match(text.preamble!, /As the user-facing root agent/);
  assert.match(text.delegation!, /^# Delegating to sub-agents\n/);
  assert.match(text.mcp!, /^# Generic MCP Connections\n[\s\S]*`aside`/);
  assert.equal(text.guidance, `# Additional Guidance\n\n${[...CHAT_BRIEF, `Work in poteto-mode: read ${join(f.agentDir, "skills/poteto-mode/SKILL.md")} before your first step.`].map(line => `- ${line}`).join("\n")}`);
  assert.equal(text.context, `# Project Context\n\nProject-specific instructions and guidelines:\n\n## ${join(f.agentDir, "AGENTS.md")}\n\n# Rules for every fixture session\n\n1. Read the unslop skill before your first prose.\n\n\n` +
    `## ${join(f.cwd, "AGENTS.md")}\n\n# Repo rules\n\nRun npm test before a commit.\n\n\n`);
  assert.match(text.skills!, /^The following skills provide specialized instructions for specific tasks\./);
  assert.match(text.skills!, /<name>pyskill<\/name>\n {4}<type>python<\/type>\n {4}<python_import>pyskill<\/python_import>/);
  assert.doesNotMatch(text.skills!, /<name>hidden<\/name>/);
  assert.match(text.rules!, /^Project rules from .*\.claude\/rules that apply to all work in this repo:\n\n[\s\S]*Always name the file you changed\./);
  assert.match(text.harness!, /^\[harness-digest\]\n\n[\s\S]*- \[global:fixture_memory\] Fixture memory \(memories\/fixture\.md, v1\): The fixture repo runs its checks with npm test\.\n[\s\S]*<\/harness_state>$/);
  // c31 is a rule the brief holds, so a chat's block lists only c900, by its first sentence.
  assert.equal(text.corrections, "[corrections] The owner's corrections in force, live from the ledger. Read one in full with board.corrections(\"c12\") in Python, " +
    "or all with board.corrections().\n- c900 Fixture rule nobody holds yet.");
});

test("the Prime sections are byte for byte what prime-agent's buildSystemPrompt returns for the same inputs", async () => {
  const f = fixture("parity");
  const prime = await primeModules();
  const loader = new prime.DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, bundledSkillsDir: f.bundled, noExtensions: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const order = directoryOrder(join(f.agentDir, "skills"));
  const skills = [...loader.getSkills().skills].sort((a, b) => order.indexOf(a.filePath) - order.indexOf(b.filePath));
  const persona = `Work in poteto-mode: read ${join(f.agentDir, "skills/poteto-mode/SKILL.md")} before your first step.`;
  const common = { cwd: f.cwd, messagesPath: "/threads/t.sqlite", skills, contextFiles: loader.getAgentsFiles().agentsFiles, allowRecursion: true, genericMcpServers: ["aside"] };
  // A Prime browser chat: its active tools, the brief and the poteto-mode line as promptGuidelines, depth 0.
  const chat = prime.buildSystemPrompt({ ...common, selectedTools: ["ipython", "search_history", "chat_board", "tell_owner", "correction_add", "poteto_mode"],
    promptGuidelines: [...CHAT_BRIEF, persona], rlmDepth: 0 });
  assert.equal(await primeSystemPrompt({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: "/threads/t.sqlite", depth: 0, bundledSkillsDir: f.bundled }), chat);
  // A chat's job: a depth 1 child with job_reply and poteto-mode.
  const job = prime.buildSystemPrompt({ ...common, selectedTools: ["ipython", "job_reply", "poteto_mode"], rlmDepth: 1, rlmParentAgent: "fixture chat",
    promptGuidelines: [jobReplyGuideline({ chat: "fixture chat", root: false }, "t-1"), persona] });
  assert.equal(await primeSystemPrompt({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: "/threads/t.sqlite", depth: 1, parentName: "fixture chat", session: "t-1", bundledSkillsDir: f.bundled }), job);
  // The pi tool set: Prime's builder leaves out its REPL parts, as for a Prime session without ipython.
  const piTools = prime.buildSystemPrompt({ ...common, selectedTools: ["read", "bash", "edit", "write"], promptGuidelines: [...CHAT_BRIEF, persona], rlmDepth: 0 });
  assert.equal(await primeSystemPrompt({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: "/threads/t.sqlite", depth: 0, bundledSkillsDir: f.bundled, tools: "pi" }), piTools);
  assert.doesNotMatch(piTools, /The `ipython` tool is a persistent Python REPL/);
});

const systemEntries = (entries: readonly EntryRecord[]) => entries.filter(entry => entry.kind === "pi.system").map(entry => (entry.model?.[0] as { sections?: Record<string, string | null> }).sections ?? {});

test("a thread sends Prime's prompt, keeps it across turns, and sends only a changed section again", async () => {
  const f = fixture("thread");
  const file = join(dir, "thread.sqlite");
  const prompts: string[] = [];
  const firsts: string[] = [];
  const childPrompts: string[] = [];
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 16 }, () => ({ messages }: { messages: Message[] }) => {
    const user = textOf(messages.find(m => m.role === "user")?.content ?? "");
    if (user === "child task") {
      childPrompts.push(getCurrentSystemPrompt(messages));
      return fauxAssistantMessage("child answer");
    }
    prompts.push(getCurrentSystemPrompt(messages));
    firsts.push(getSystemMessageText(messages[0] as Parameters<typeof getSystemMessageText>[0]));
    const last = textOf([...messages].reverse().find(m => m.role === "user")?.content ?? "");
    if (last === "delegate" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("subagent", { task: "child task" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("ok");
  }));
  models.setProvider(faux.provider);
  const registry = threadRegistry({ agentDir: f.agentDir, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, thread: { id: "t", file, name: () => "fixture chat", cwd: f.cwd } });
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off", cwd: f.cwd } });
  const ask = async (text: string) => {
    const settled = await (await root.submit({ type: "input", content: text }, context)).wait(context);
    assert.equal(settled.status, "done");
    return [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  };

  await ask("first");
  const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: file, depth: 0, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir });
  assert.equal(prompts[0], parts.filter(part => part.key !== "harness").map(part => part.text).join("\n\n"), "the model gets every section but the digest, joined as pi-ai joins them");
  assert.ok(prompts[0]!.startsWith(await primeSystemPrompt({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: file, depth: 0, bundledSkillsDir: f.bundled })));

  // Unchanged files: the second turn writes no new system entry, so the cached prefix holds.
  let entries = await ask("second");
  assert.equal(systemEntries(entries).length, 1);
  assert.equal(prompts[1], prompts[0]);

  // A changed AGENTS.md, harness and ledger: only the context section goes again; the corrections stay as first sent.
  writeFileSync(join(f.cwd, "AGENTS.md"), "# Repo rules\n\nRun npm test and npm run lint before a commit.\n");
  writeFileSync(join(f.agentDir, "harness", "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] }));
  writeFileSync(join(f.ledgerDir, "corrections.json"), JSON.stringify({ corrections: [] }));
  entries = await ask("third");
  const systems = systemEntries(entries);
  assert.equal(systems.length, 2);
  assert.deepEqual(Object.keys(systems[1]!), ["context"]);
  assert.match(systems[1]!.context!, /Run npm test and npm run lint before a commit\./);
  assert.equal(firsts[2], firsts[0], "the first system message, the cached prefix, is unchanged");
  assert.doesNotMatch(prompts[2]!, /\[harness-digest\]/, "the root's digest is a message, never a section");
  assert.match(prompts[2]!, /- c900 Fixture rule/);

  // A subagent's child conversation gets a chat job's prompt: depth 1, spawned by the chat, job_reply and no brief.
  await ask("delegate");
  assert.equal(childPrompts.length, 1);
  const child = childPrompts[0]!;
  assert.match(child, /Recursive agent depth: 1\n/);
  assert.match(child, /You are a child agent spawned by fixture chat\./);
  assert.match(child, /- You are a job of the chat fixture chat\./);
  assert.doesNotMatch(child, /This session is a chat\./);
  assert.doesNotMatch(child, /As the user-facing root agent/);
  await harness.close(context);
});

test("pi-host's threads run with it: the thread file is the conversation log, and the digest before the owner's words is ranked by them", async () => {
  const f = fixture("threads");
  // A second memory that only a question about deploys ranks first: the digest shows six entries a kind, so add enough to cut.
  const state = JSON.parse(readFileSync(join(f.agentDir, "harness", "harness_state.json"), "utf8"));
  for (let i = 0; i < 8; i++) state.entries.memory[`a_filler_${i}`] = { ...state.entries.memory.fixture_memory, id: `a_filler_${i}`, title: `Filler ${i}`, content: "Nothing to see.", path: `memories/a-${i}.md` };
  state.entries.memory.zz_deploys = { ...state.entries.memory.fixture_memory, id: "zz_deploys", title: "Deploys", content: "Staging deploys run from the staging branch.", path: "memories/zz.md" };
  writeFileSync(join(f.agentDir, "harness", "harness_state.json"), JSON.stringify(state));
  let prompt = "";
  let sent: Message[] = [];
  const threads = new DurableThreads({
    dir: join(dir, "threads-durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses([({ messages }) => { prompt = getCurrentSystemPrompt(messages); sent = messages; return fauxAssistantMessage("ok"); }]);
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: f.cwd,
    prompt: { agentDir: f.agentDir, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir },
  });
  try {
    const thread = await threads.create({ name: "deploy chat" });
    const { submission } = await threads.submit(thread.id, { text: "how do staging deploys run?" });
    assert.equal((await threads.wait(thread.id, submission)).status, "done");
    assert.match(prompt, new RegExp(`Conversation log: ${threads.fileOf(thread.id)}\n`));
    assert.doesNotMatch(prompt, /\[harness-digest\]/);
    const users = sent.filter(message => message.role === "user").map(message => textOf(message.content));
    assert.equal(users.length, 2);
    assert.match(users[0]!, /^\[harness-digest\]\n/);
    assert.match(users[0]!, /- \[global:zz_deploys\] Deploys/);
    assert.match(users[0]!, /entries ranked by relevance to the current task/);
    assert.equal(users[1], "how do staging deploys run?");
  } finally {
    await threads.shutdown();
  }
});
