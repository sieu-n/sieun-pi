// Guards the 10-19 incident: readme-preview run4's job saved a global harness memory about RefuseManualStop servers, and it loaded into every other live session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Prime gives every kernel RLM_GLOBAL_HARNESS_STATE_DIR=~/.prime/agent/harness, so `rlm.harness.create_memory(..., global_=True)` in a trial
 * wrote the store every session loads. This runs the extension's real tool_call hook for sessions of a trial chat and for another session, and
 * runs each cell it hands on in Prime's own rlm package (the prime-agent dependency) with the environment Prime's host sets.
 */
const RLM = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/prime-agent/dist/prime-agent-runtime/src");
const root = realpathSync(mkdtempSync(join(tmpdir(), "trial-harness-")));
const agentDir = join(root, "agent");
const data = join(root, "browser-chat");
const run = join(root, "clean-room", "run-1");
mkdirSync(data, { recursive: true });
mkdirSync(run, { recursive: true });
process.env.SIEUN_PI_HOSTS = join(root, "no-hosts.json");

const published = join(agentDir, "harness");
const kernel = (code: string): string => execFileSync("python3", ["-c", code], { encoding: "utf8",
  env: { PATH: process.env.PATH ?? "", HOME: root, PYTHONPATH: RLM, RLM_GLOBAL_HARNESS_STATE_DIR: published, RLM_SESSION_DIR: join(root, "session") } });
const titles = (file: string): string[] => Object.values((JSON.parse(readFileSync(file, "utf8")) as { entries: { memory: Record<string, { title: string }> } }).entries.memory)
  .map(entry => entry.title).sort();
const LIST = `import json, rlm\nprint(json.dumps(sorted(entry.title for entry in rlm.harness.list("memory", global_=True))))\n`;

/** A session's header and names, as Prime's session manager gives them to the hook. */
function session(id: string, header: Record<string, unknown>, name = ""): unknown {
  return { sessionManager: { getHeader: () => ({ type: "session", id, ...header }), getSessionId: () => id, getSessionName: () => name,
    getEntries: () => [], getBranch: () => [], getSessionFile: () => join(root, `${id}.jsonl`) } };
}

test("a trial's global harness write stays in its run, and the trial starts from the published entries", async () => {
  kernel(`import rlm\nrlm.harness.create_memory("published default", "Every session reads this.", global_=True)\n`);
  const { fileTrialHarness, keepTrialHarness, seedTrialHarness } = await import("../src/trial-harness.ts");
  const { jobRegistry } = await import("../src/chat-sources.ts");
  const store = seedTrialHarness(run, agentDir);
  await fileTrialHarness(data, [{ id: "trial-chat", name: "readme preview" }], store);
  await jobRegistry(join(data, "chat-jobs.json")).add(["readme job"], "readme preview", "trial-chat");
  writeFileSync(join(root, "trial-chat.jsonl"), `${JSON.stringify({ type: "session", id: "trial-chat" })}\n`);

  const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  const pi = new Proxy({}, { get: (_target, key) => key === "on" ? (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (name === "tool_call") handlers.push(handler); }
    : key === "getFlag" ? (flag: string) => flag === "agent-chat-data-dir" ? data : undefined : () => undefined });
  const { default: historyExtension } = await import("../extension/index.ts");
  /** One ipython cell of a new session: Prime loads the extension once per session, and the cell is what its tool_call hooks hand on. */
  const cell = async (ctx: unknown, code: string): Promise<string> => {
    const loaded = handlers.length;
    historyExtension(pi as never);
    const event = { type: "tool_call", toolName: "ipython", toolCallId: "call", input: { code } };
    for (const handler of handlers.slice(loaded)) await handler(event, ctx);
    return event.input.code;
  };
  const last = (output: string): unknown => JSON.parse(output.trim().split("\n").at(-1)!);

  assert.deepEqual(last(kernel(await cell(session("trial-chat", {}, "readme preview"), LIST))), ["published default"], "the trial chat starts from the published entries");
  kernel(await cell(session("trial-job", { parentSession: join(root, "trial-chat.jsonl"), rlmDepth: 1 }),
    `import rlm\nrlm.harness.create_memory("RefuseManualStop servers", "A job of the trial chat wrote this.", global_=True)\n`));
  kernel(await cell(session("trial-root", {}, "readme job"), `import rlm\nrlm.harness.create_memory("trial root note", "A root the trial chat started wrote this.", global_=True)\n`));

  assert.deepEqual(titles(join(published, "harness_state.json")), ["published default"], "the published store holds no trial entry");
  assert.deepEqual(titles(join(store, "harness_state.json")), ["RefuseManualStop servers", "published default", "trial root note"]);
  const fresh = await cell(session("other-session", {}), LIST);
  assert.ok(!fresh.includes(store), "a session outside the trial keeps Prime's store");
  assert.deepEqual(last(kernel(fresh)), ["published default"], "a fresh session outside the trial never sees the trial's entries");

  const kept = keepTrialHarness(run);
  assert.ok(kept && existsSync(kept));
  assert.deepEqual(titles(kept), ["RefuseManualStop servers", "published default", "trial root note"], "teardown keeps the trial's store next to the verdict");
});
