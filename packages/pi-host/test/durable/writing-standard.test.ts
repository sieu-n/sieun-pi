/**
 * Every thread gets the unslop skill's text in full as the `writing` section of its system prompt (`prime-prompt.ts` `writingStandard`),
 * because a skill shows only its name until the model opens the file and a comm thread cannot open one. The owner asked in dm_agent-factory
 * p58 (msg mwqtk65x) whether unslop was loaded, and it was not. The section sits in the leading system block, before the block's cache
 * breakpoint, so it costs a cache read on a warm turn, and the next request starts with the same bytes (c41).
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, type Message, type Provider, type Tool } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { withCacheShape } from "../../src/durable/cache-shape.ts";
import { primePromptParts, WRITING_SKILL } from "../../src/durable/prime-prompt.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-writing-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

function fixture(name: string) {
  const root = join(dir, name);
  const agentDir = join(root, "agent");
  cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "# Repo rules\n\nRun npm test before a commit.\n");
  const bundled = join(root, "bundled");
  mkdirSync(bundled);
  return { agentDir, cwd, bundled, ledgerDir: join(agentDir, "browser-chat"), skill: join(agentDir, "skills", WRITING_SKILL, "SKILL.md") };
}

const RULE = "1. Use no em dashes. End the sentence or use a comma.";
const section = (skill: string) =>
  `# Writing standard\n\nThe unslop skill (${skill}) is loaded here in full, so you need not open it. Follow it in every line a person reads.\n\n# Unslop\n\n${RULE}`;

test("a chat, a job and a comm root each get the unslop skill's text without its frontmatter as the last section", async () => {
  const f = fixture("parts");
  for (const input of [{ depth: 0 }, { depth: 1, parentName: "fixture chat", session: "t-1" }, { depth: 0, comm: true }]) {
    const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, ...input });
    assert.equal(parts.at(-1)!.key, "writing");
    assert.equal(parts.at(-1)!.text, section(f.skill));
    assert.match(parts.find(part => part.key === "skills")!.text, /<name>unslop<\/name>/, "the skills list still names it");
  }
  rmSync(join(f.agentDir, "skills", WRITING_SKILL), { recursive: true });
  const without = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, depth: 0 });
  assert.ok(!without.some(part => part.key === "writing"), "no unslop skill, no section");
});

for (const role of ["comm", "work"] as const) {
  test(`a ${role} thread's root sends the section in its first system message and no new system entry while the file stays the same`, async () => {
    const f = fixture(role);
    const roots: Message[][] = [];
    const threads = new DurableThreads({
      dir: join(dir, role, "durable"),
      models: () => {
        const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
        faux.setResponses(Array.from({ length: 4 }, () => ({ messages }: { messages: Message[] }) => {
          roots.push(messages);
          return fauxAssistantMessage("ok");
        }));
        const models = createModels();
        models.setProvider(faux.provider);
        return models;
      },
      defaultModel: MODEL,
      defaultThinkingLevel: "off",
      defaultCwd: f.cwd,
      prompt: { agentDir: f.agentDir, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir },
    });
    const folder = join(dir, role, "agents", "vent");
    mkdirSync(folder, { recursive: true });
    try {
      const { id } = await threads.create({ name: `vent ${role}` });
      await threads.docPut(id, "agent.ref", { agent: "ag_vent", dir: folder, role, ...(role === "comm" ? { room: "dm_vent", work: "w-1" } : {}) });
      for (const text of ["first", "second"]) {
        const { submission } = await threads.submit(id, { text });
        assert.equal((await threads.wait(id, submission)).status, "done");
      }
      assert.equal(roots.length, 2);
      assert.ok(getCurrentSystemPrompt(roots[0]!).includes(`\n\n${section(f.skill)}`), "the first request holds the section");
      // A work root keeps its pinned corrections, and on 11-21 the first build of this change then dropped the section on the second request.
      assert.equal(roots[1]!.filter(message => message.role === "system").length, 1, "the second request adds no system update");
      assert.deepEqual(roots[1]![0], roots[0]![0], "and its first system message is the first request's");
    } finally {
      await threads.shutdown();
    }
  });
}

const tool = (name: string): Tool => ({ name, description: name, parameters: { type: "object", properties: {} } } as unknown as Tool);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });
const answer = (text: string, timestamp: number): Message =>
  ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "claude-fable-5", usage, stopReason: "stop", timestamp } as Message);

type Body = { system: { text: string; cache_control?: unknown }[]; tools: unknown; messages: { role: string; content: unknown }[] };

/** The body pi-ai's Anthropic provider sends for `messages`, caught by a fetch that answers 400. */
async function wire(provider: Provider, messages: Message[]): Promise<Body> {
  const model = provider.getModels().find(m => (m.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages);
  assert.ok(model);
  let body: unknown;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "test" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  await provider.stream(model, { messages } as never, { apiKey: "sk-ant-api-test", fetch, cacheRetention: "long", maxRetries: 0 } as never).result();
  return body as Body;
}
const bare = (body: unknown) => JSON.parse(JSON.stringify(body, (key, value) => key === "cache_control" ? undefined : value)) as Body;

test("on the wire the section is in the system block before its cache breakpoint, and the next request starts with the same bytes", async () => {
  const f = fixture("wire");
  const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, depth: 0, comm: true });
  const head = { role: "system", content: "", sections: Object.fromEntries(parts.map(part => [part.key, part.text])), toolsAdded: [tool("tell_owner")], timestamp: 0 } as Message;
  const t0 = 1_800_000_000_000;
  const turns: Message[][] = [
    [head, user("one", t0)],
    [head, user("one", t0), answer("ok", t0 + 1000), user("two", t0 + 60_000)],
  ];
  const provider = withCacheShape(anthropicProvider(), () => t0 + 60_000);
  const bodies: Body[] = [];
  for (const messages of turns) bodies.push(await wire(provider, messages));
  const [first, second] = bodies as [Body, Body];
  assert.equal(first.system.length, 1);
  assert.ok(first.system[0]!.text.endsWith(section(f.skill)), "the section closes the system block");
  assert.ok(first.system[0]!.cache_control, "the system block, and so the section, ends at a cache breakpoint");
  const [a, b] = [bare(first), bare(second)];
  assert.deepEqual(b.system, a.system);
  assert.deepEqual(b.tools, a.tools);
  // The last message carries the conversation's breakpoint, which turns its text into a block, so the prefix runs up to it.
  assert.deepEqual(b.messages.slice(0, a.messages.length - 1), a.messages.slice(0, -1), "the second request starts with the first one's messages");
  assert.equal(readFileSync(f.skill, "utf8").startsWith("---\nname: unslop"), true, "the fixture's file has the frontmatter the section drops");
});
