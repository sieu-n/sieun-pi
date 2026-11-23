/**
 * An agent's working memory (`working-memory.ts`): every thread of the agent, and a job inside one, reads `working-memory.md` in full as
 * the last section of its prompt; a rewrite reaches the next request as that one section, after the cached prefix; a missing or blank file
 * and a thread with no agent show none. The work thread's role text names the file and tells it to rewrite it, and a comm thread answers a
 * status question from it before it reads the work thread.
 *
 * Run: cd packages/pi-host && node --import tsx --test --test-force-exit --test-isolation=none test/durable/working-memory.test.ts
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
import { commInstructions, workInstructions } from "../../src/durable/agent-profile.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { readWorkingMemory } from "../../src/durable/working-memory.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-working-memory-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

function fixture(name: string) {
  const root = join(dir, name);
  const agentDir = join(root, "agent");
  cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const bundled = join(root, "bundled");
  mkdirSync(bundled);
  const folder = join(root, "agents", "vent");
  mkdirSync(folder, { recursive: true });
  return { root, agentDir, cwd, bundled, folder, file: join(folder, "working-memory.md") };
}

const userTexts = (messages: readonly Message[]) => messages.filter(message => message.role === "user").map(message => textOf(message.content));
const sectionsOf = (entries: readonly EntryRecord[]) => entries.filter(entry => entry.kind === "pi.system").map(entry => (entry.model?.[0] as { sections?: Record<string, string | null> }).sections ?? {});

function threadsOn(f: ReturnType<typeof fixture>) {
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
    dir: join(f.root, "durable"),
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
    prompt: { agentDir: f.agentDir, bundledSkillsDir: f.bundled, ledgerDir: join(f.agentDir, "browser-chat") },
  });
  const ask = async (id: string, text: string) => {
    const { submission } = await threads.submit(id, { text });
    assert.equal((await threads.wait(id, submission)).status, "done");
  };
  const systems = async (id: string) => sectionsOf((await threads.entries(id, { after: 0, limit: 500 })).entries);
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

test("a thread of the agent reads the whole file as its last section, a rewrite sends only that section, and a job inside it reads it too", async () => {
  const f = fixture("read");
  writeFileSync(f.file, "# Working on\n\n- The relay page shows Mac uptime, for dm_vent p41.\n");
  const { threads, roots, children, ask, systems } = threadsOn(f);
  try {
    const thread = await threads.create({ name: "vent · DM" });
    await threads.docPut(thread.id, "agent.ref", { agent: "ag_vent", dir: f.folder, role: "comm", room: "dm_vent", work: "w-1" });
    await ask(thread.id, "what are you working on?");
    const [first] = await systems(thread.id);
    assert.deepEqual(Object.keys(first!).slice(-2), ["working", "instructions"], "the working memory is the last section before the role text");
    assert.match(first!.working!, /^# Working memory\n\nAgent vent's working memory, .*working-memory\.md, last written \d{4}-\d\d-\d\d \d\d:\d\dZ\./);
    assert.match(first!.working!, /<working_memory>\n# Working on\n\n- The relay page shows Mac uptime, for dm_vent p41\.\n<\/working_memory>$/);
    assert.ok(getCurrentSystemPrompt(roots[0]!).includes("The relay page shows Mac uptime"));

    await ask(thread.id, "and now?");
    assert.equal((await systems(thread.id)).length, 1, "an unchanged file writes no new system entry");

    writeFileSync(f.file, "# Working on\n\n- Waiting on the Mac relay to answer.\n");
    await ask(thread.id, "and now?");
    const entries = await systems(thread.id);
    assert.equal(entries.length, 2);
    assert.deepEqual(Object.keys(entries[1]!), ["working"], "only the working section changes");
    assert.match(entries[1]!.working!, /Waiting on the Mac relay/);
    const head = (messages: Message[]) => getSystemMessageText(messages[0] as Parameters<typeof getSystemMessageText>[0]);
    assert.equal(head(roots[2]!), head(roots[0]!), "the first system message, the cached prefix, is unchanged");

    const work = await threads.create({ name: "vent" });
    await threads.docPut(work.id, "agent.ref", { agent: "ag_vent", dir: f.folder, role: "work", comm: thread.id });
    await ask(work.id, "delegate");
    const child = await until("the child's request", () => children[0]);
    assert.match(getCurrentSystemPrompt(child), /<working_memory>\n# Working on\n\n- Waiting on the Mac relay to answer\.\n<\/working_memory>/, "a job inside the work thread reads it");
  } finally {
    await threads.shutdown();
  }
});

test("a thread with no agent shows no working memory, and a missing or blank file shows a line that only changes its text", async () => {
  const f = fixture("none");
  const { threads, ask, systems } = threadsOn(f);
  try {
    const plain = await threads.create({ name: "plain" });
    writeFileSync(f.file, "# Working on\n\n- Something.\n");
    await ask(plain.id, "hi");
    assert.ok((await systems(plain.id)).every(sections => !("working" in sections)), "a thread with no agent.ref");

    writeFileSync(f.file, "  \n");
    assert.equal(readWorkingMemory({ dir: f.folder }), undefined);
    const work = await threads.create({ name: "vent" });
    await threads.docPut(work.id, "agent.ref", { agent: "ag_vent", dir: f.folder, role: "work" });
    await ask(work.id, "hi");
    const blank = (await systems(work.id))[0]!.working!;
    assert.equal(blank, `# Working memory\n\nAgent vent has no working memory yet. Its work thread writes it to ${f.file} after its turns.`);

    writeFileSync(f.file, "# Working on\n\n- The relay page.\n");
    await ask(work.id, "again");
    let entries = await systems(work.id);
    assert.deepEqual(Object.keys(entries.at(-1)!), ["working"], "a file written later changes the section's text alone");
    assert.match(entries.at(-1)!.working!, /The relay page/);
    rmSync(f.file);
    await ask(work.id, "gone");
    entries = await systems(work.id);
    assert.deepEqual(entries.at(-1), { working: blank }, "a removed file goes back to the line");
  } finally {
    await threads.shutdown();
  }
});

test("the work thread's role text names the file and has it rewrite it, and a comm thread answers status from it first", () => {
  const work = workInstructions({ agent: "ag_vent", comm: "c-1", dir: "/agents/vent" });
  assert.match(work, /You alone write your agent's working memory, `\/agents\/vent\/working-memory\.md`[\s\S]*Before you end a turn in which anything in it changed, rewrite the whole file/);
  assert.match(work, /Step status stays on the board/);
  const comm = commInstructions({ agent: "ag_vent", room: "dm_vent", work: "w-1" });
  assert.match(comm, /Answer a status question, such as what the agent works on, from its working memory[\s\S]*agent_observe\.get_agent\("w-1"\)`[\s\S]*only when the question needs what it does this minute/);
});
