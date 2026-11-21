// 11-21: the owner asked "skill:unslop 이거 로드되고 있지?" (msg mwqtk65x), and it was not. A chat on :5182 saw only the skill's name in its skills
// list, and from 11-14 to 11-21 one of 12 chats opened the file, for 200 characters (~/work/unslop-loaded/A-findings.md). The poteto_mode tool now
// puts the skill's full text in the base prompt of a chat, each job of it and every subagent under them. This runs the extension's real hooks and
// Prime 0.9.8's own prompt choice (AgentSession._applyPreparedSystemPrompt), as job-prompt-cache.test.ts does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession } from "prime-agent";

const UNSLOP = readFileSync(join(import.meta.dirname, "../../../../skills/unslop/SKILL.md"), "utf8");
const BODY = UNSLOP.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const BASE = "You are the base prompt.";
const JOB = "01a16932-f203-7238-ab8a-5e2eb92f3b07";
const CHAT = "01a16932-f203-7238-ab8a-5e2eb92f3b08";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; promptGuidelines?: string[] };

/** One load of the extension: Prime's base prompt is the fixed text plus each registered tool's guidelines as Prime 0.9.8 renders them. */
async function load(data: string, session: { id: string; name: string; chat: boolean }) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const agent = Object.assign(Object.create(AgentSession.prototype) as object, { agent: { state: { systemPrompt: "" } }, _baseSystemPrompt: BASE }) as
    { agent: { state: { systemPrompt: string } }; _baseSystemPrompt: string };
  const rebuild = () => {
    const lines = [...new Set([...tools.values()].flatMap(tool => tool.promptGuidelines ?? []).map(line => line.trim()))];
    agent._baseSystemPrompt = lines.length ? `${BASE}\n\n# Additional Guidance\n\n${lines.map(line => `- ${line}`).join("\n")}` : BASE;
  };
  const pi = new Proxy({}, { get: (_target, key) => {
    if (key === "on") return (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]);
    if (key === "registerTool") return (tool: Tool) => { tools.set(tool.name, tool); rebuild(); };
    if (key === "getFlag") return (flag: string) => flag === "agent-chat-data-dir" ? data : flag === "chat" ? session.chat : undefined;
    if (key === "getActiveTools") return () => ["ipython", ...tools.keys()];
    return () => undefined;
  } });
  const { default: historyExtension } = await import(`../extension/index.ts?load=${Math.random()}`);
  historyExtension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => session.id, getSessionName: () => session.name, getHeader: () => ({ type: "session", id: session.id }),
    getEntries: () => [], getBranch: () => [], getSessionFile: () => join(data, `${session.id}.jsonl`) } };
  const emit = async (name: string, event: unknown) => { let last: unknown; for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx) ?? last; return last; };
  await emit("session_start", { type: "session_start", reason: "startup" });
  return async (): Promise<string> => {
    const snapshot = agent._baseSystemPrompt;
    const result = await emit("before_agent_start", { type: "before_agent_start", prompt: "go", systemPrompt: snapshot });
    (AgentSession.prototype as unknown as { _applyPreparedSystemPrompt: (this: unknown, prepared: unknown, preserve: boolean) => void })._applyPreparedSystemPrompt.call(agent, { result, basePromptSnapshot: snapshot }, false);
    return agent.agent.state.systemPrompt;
  };
}

const count = (text: string, part: string) => text.split(part).length - 1;

test("a chat's and a job's system prompt hold the unslop skill's text once, in the base prompt every turn sends", async t => {
  const home = mkdtempSync(join(tmpdir(), "writing-standard-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".prime", "agent");
  process.env.SIEUN_PI_HOSTS = join(home, "no-hosts.json");
  const data = join(home, ".prime", "agent", "browser-chat");
  mkdirSync(data, { recursive: true });
  for (const [name, text] of [["poteto-mode", "---\nname: poteto-mode\n---\n"], ["unslop", UNSLOP]] as const) {
    mkdirSync(join(home, ".prime", "agent", "skills", name), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "skills", name, "SKILL.md"), text);
  }
  const { jobRegistry } = await import("../src/chat-sources.ts");
  await jobRegistry(join(data, "chat-jobs.json")).add(["writing fixture job"], "Crawler VP");

  const chat = await load(data, { id: CHAT, name: "writing fixture chat", chat: true });
  const job = await load(data, { id: JOB, name: "writing fixture job", chat: false });
  for (const [who, turn] of [["chat", chat], ["job", job]] as const) {
    const one = await turn();
    assert.ok(BODY.length > 5000 && BODY.startsWith("# Unslop"), "the fixture is the real skill");
    assert.equal(count(one, BODY), 1, `the ${who}'s prompt holds the skill's text once`);
    assert.equal(count(one, "name: unslop"), 0, `the ${who}'s prompt leaves out the frontmatter`);
    assert.ok(one.endsWith(BODY), `the skill's text closes the ${who}'s Additional Guidance`);
    assert.ok(one.includes(`- Work in poteto-mode: read `), `the ${who} keeps the poteto-mode line`);
    assert.equal(await turn(), one, `the ${who}'s second turn sends the same system prompt, so the cache prefix holds`);
  }
});
