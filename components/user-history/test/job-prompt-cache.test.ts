// 10-23 on us-metal02: a root job whose name was filed after its session_start got job_reply and poteto_mode in its first before_agent_start.
// Prime rebuilt the base prompt with their two guideline lines, and the hook also appended both lines to the prompt, so the first turn sent them
// twice and every later turn (or the first after an unload) sent them once. The changed system prompt wrote the job's whole prompt cache again.
// This runs the extension's real hooks for such a job and Prime 0.9.8's own prompt choice (AgentSession._applyPreparedSystemPrompt).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession } from "prime-agent";

const JOB = "01a16932-f203-7238-ab8a-5e2eb92f3b06";
const NAME = "cache fixture job";
const BASE = "You are the base prompt.";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; promptGuidelines?: string[] };

/** One load of the extension in a worker: Prime's base prompt is the fixed text plus each registered tool's guidelines, rebuilt on register. */
async function load(data: string) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const session = Object.assign(Object.create(AgentSession.prototype) as object, { agent: { state: { systemPrompt: "" } }, _baseSystemPrompt: BASE }) as
    { agent: { state: { systemPrompt: string } }; _baseSystemPrompt: string };
  const rebuild = () => {
    const lines = [...tools.values()].flatMap(tool => tool.promptGuidelines ?? []);
    session._baseSystemPrompt = lines.length ? `${BASE}\n\n# Additional Guidance\n\n${lines.map(line => `- ${line}`).join("\n")}` : BASE;
  };
  const pi = new Proxy({}, { get: (_target, key) => {
    if (key === "on") return (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]);
    if (key === "registerTool") return (tool: Tool) => { tools.set(tool.name, tool); rebuild(); };
    if (key === "getFlag") return (flag: string) => flag === "agent-chat-data-dir" ? data : undefined;
    if (key === "getActiveTools") return () => ["ipython", ...tools.keys()];
    return () => undefined;
  } });
  const { default: historyExtension } = await import(`../extension/index.ts?load=${Math.random()}`);
  historyExtension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => JOB, getSessionName: () => NAME, getHeader: () => ({ type: "session", id: JOB }), getEntries: () => [],
    getBranch: () => [], getSessionFile: () => join(data, `${JOB}.jsonl`) } };
  const emit = async (name: string, event: unknown) => { let last: unknown; for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx) ?? last; return last; };
  await emit("session_start", { type: "session_start", reason: "startup" });
  /** The system prompt of the next turn, chosen the way Prime chooses it after before_agent_start. */
  const turn = async (): Promise<string> => {
    const snapshot = session._baseSystemPrompt;
    const result = await emit("before_agent_start", { type: "before_agent_start", prompt: "go", systemPrompt: snapshot });
    (AgentSession.prototype as unknown as { _applyPreparedSystemPrompt: (this: unknown, prepared: unknown, preserve: boolean) => void })._applyPreparedSystemPrompt.call(session, { result, basePromptSnapshot: snapshot }, false);
    return session.agent.state.systemPrompt;
  };
  return { turn };
}

test("a root job filed after its session_start sends one system prompt on every turn and after a reload", async t => {
  const home = mkdtempSync(join(tmpdir(), "job-prompt-cache-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".prime", "agent");
  process.env.SIEUN_PI_HOSTS = join(home, "no-hosts.json");
  const data = join(home, ".prime", "agent", "browser-chat");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, ".prime", "agent", "skills", "poteto-mode"), { recursive: true });
  writeFileSync(join(home, ".prime", "agent", "skills", "poteto-mode", "SKILL.md"), "---\nname: poteto-mode\n---\n");
  const { jobRegistry } = await import("../src/chat-sources.ts");

  const first = await load(data);
  await jobRegistry(join(data, "chat-jobs.json")).add([NAME], "Crawler VP");
  const one = await first.turn();
  const two = await first.turn();
  assert.equal(one.split("You are a job of the chat Crawler VP.").length - 1, 1, "the job line is in the first turn's prompt once");
  assert.ok(one.includes("Work in poteto-mode: read "), "the first turn has the poteto-mode line");
  assert.equal(two, one, "the second turn sends the first turn's system prompt, so its cache prefix holds");
  const reloaded = await load(data);
  assert.equal(await reloaded.turn(), one, "a reload after an unload builds the same system prompt");
});
