import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@sieun-pi/pi-testkit/faux";
import piRlm from "@sieun-pi/pi-rlm";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { PiHost } from "../src/host.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

type Ctx = { systemPrompt?: string; messages: { role: string; content: unknown; customType?: string }[] };
const text = (c: Ctx) => JSON.stringify(c.messages.at(-1)?.content ?? "");
const cell = (code: string) => fauxAssistantMessage(fauxToolCall("ipython", { code }));
const say = (words: string) => fauxAssistantMessage([fauxText(words)]);

let root: string;
let host: PiHost;
const faux = fauxProvider();

/**
 * One responder for every request: it reads the last message and plays the agent through a goal, an RLM heartbeat, a compaction it asks for
 * from Python, the resume after it, and goal.complete().
 */
function agent(c: Ctx): AssistantMessage {
  const last = text(c);
  if (c.systemPrompt?.includes("context summarization assistant") || /<conversation>|The messages above are/.test(last)) return say("## Goal\nFinish the list. The heartbeat and the goal are set.");
  if (last.includes("start the work")) return cell(`g = await goal.create("finish the list")\nh = await rlm_heartbeat.create("check the list", interval="1m", label="list")\nprint(g["goal"]["status"], h["heartbeat"]["label"])`);
  if (last.includes("active list")) return say("set up the goal and the heartbeat");
  const resumed = c.messages.some(m => JSON.stringify(m.content).includes("[compaction-resume]"));
  if (/\[goal: continuation\]|\[python-state\]|\[compaction-resume\]/.test(last) && !resumed) return cell(`print(await compact.run("keep the goal"))`);
  if (last.includes("'scheduled': True")) return say("compaction requested");
  if (/\[goal: continuation\]|\[python-state\]|\[compaction-resume\]/.test(last)) return cell(`r = await goal.complete()\nprint(r["goal"]["status"], (await goal.get())["goal"]["status"])`);
  if (last.includes("complete complete")) return say("all done");
  return say(`unexpected: ${last.slice(0, 200)}`);
}

before(async () => {
  await testPython();
  root = mkdtempSync(join(tmpdir(), "pi-host-rlm-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  faux.core.setResponses(Array.from({ length: 200 }, () => agent as never));
  host = new PiHost({
    agentDir, sessionDir: join(root, "sessions"), defaultCwd: join(root, "ws"), extensionFactories: [faux.factory, piRlm],
    defaultModel: { provider: faux.provider, id: faux.model }, log: () => {},
    resourceLoaderOptions: { noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
});

after(async () => {
  await host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("goal, compact and rlm_heartbeat work from the kernel of a pi-host session, and compaction resumes the turn", { timeout: 120_000 }, async () => {
  const opened = await host.openSession({ name: "kernel-skills" });
  const session = opened.session;
  await host.startPrompt(opened, "start the work");
  const deadline = Date.now() + 30_000;
  while (session.getLastAssistantText() !== "all done" || session.isStreaming) {
    assert.ok(Date.now() < deadline, `stalled at: ${JSON.stringify(session.messages.slice(-8).map(m => [m.role, (m as { customType?: string }).customType, JSON.stringify((m as { content?: unknown }).content ?? "").slice(0, 160)]))}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const messages = session.sessionManager.getEntries();
  const customs = messages.filter(e => e.type === "custom_message").map(e => (e as { customType: string }).customType);
  assert.ok(customs.includes("goal_context"), "the active goal sent a continuation");
  assert.ok(customs.includes("compaction_resume"), "the compaction resumed the turn");
  assert.equal(messages.filter(e => e.type === "compaction").length, 1);
  const tools = messages.filter(e => e.type === "message" && (e as { message: { role: string } }).message.role === "toolResult").map(e => JSON.stringify((e as { message: { content: unknown } }).message.content));
  assert.ok(tools.some(t => t.includes("active list")), tools.join("\n"));
  assert.ok(tools.some(t => t.includes("complete complete")), tools.join("\n"));
  const jobs = host.scheduler.list({ sessionId: opened.id, source: "rlm_heartbeat" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.label, "list");
  assert.equal(customs.filter(c => c === "goal_context").length, 1, "a completed goal sends no more continuations");
});
