import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";

/*
 * pi-host hosts every session in one process, so a guard judge that runs 600 ms of sync work must not hold that process's loop.
 * The fixture guard busy-waits in its tool_call handler and answers with what it read from the event and ctx, so the test sees
 * both the loop's lag and that the verdict matches the one the loop itself gives.
 */
const checkout = mkdtempSync(join(tmpdir(), "auto-sns-agent-worker-"));
after(() => rmSync(checkout, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { stdio: ["ignore", "pipe", "pipe"] });
const files: Record<string, string> = {
	"scripts/repo/agent/guards/prime.mjs": `import { isMainThread } from 'node:worker_threads';
const notes = new Map();
export function onToolCall(event, ctx) {
  const text = event.input.command ?? event.input.code;
  if (!isMainThread && text === 'throws off the loop') throw new Error('worker only');
  if (text.includes('busy')) { const end = Date.now() + 600; while (Date.now() < end); }
  if (text.includes('note')) { notes.set(event.toolCallId, 'a note for ' + text); return undefined; }
  if (text.includes('allow')) return undefined;
  return { block: true, reason: [event.toolName, text, ctx.cwd, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile()].join('|') };
}
export function registerRepoGuard(pi) {
  pi.on('tool_call', (event, ctx) => onToolCall(event, ctx));
  pi.on('tool_result', (event) => {
    const note = notes.get(event.toolCallId);
    if (note === undefined) return undefined;
    notes.delete(event.toolCallId);
    return { content: [...event.content, { type: 'text', text: note }] };
  });
}
`,
};
for (const [name, text] of Object.entries(files)) {
	mkdirSync(resolve(checkout, name, ".."), { recursive: true });
	writeFileSync(join(checkout, name), text);
}
git("init", "-q");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
process.env.GLOBAL_RULES_AUTO_SNS_AGENT = checkout;
const logFile = join(checkout, "global-rules.log");
process.env.GLOBAL_RULES_LOG = logFile;

type Handler = (event: unknown, ctx: unknown) => unknown;
const rules = await import("../src/auto-sns-agent.ts");
const handlers = new Map<string, Handler>();
await rules.register({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
const ctx = { cwd: "/srv/start", sessionManager: { getSessionId: () => "s-1", getSessionFile: () => "/sessions/s-1.jsonl" } };
const call = (toolName: string, input: Record<string, unknown>, toolCallId = "c1") => handlers.get("tool_call")!({ type: "tool_call", toolCallId, toolName, input }, ctx);

/** How late a 10 ms timer set when `work` starts fires. */
async function lagDuring<T>(work: () => Promise<T>): Promise<{ value: T; lagMs: number }> {
	const start = performance.now();
	const fired = new Promise<number>(done => setTimeout(() => done(performance.now()), 10));
	const value = await work();
	return { value, lagMs: (await fired) - start - 10 };
}

test("a guard judge that runs 600 ms leaves the loop free and gives the verdict the loop gives", async () => {
	assert.deepEqual(await call("bash", { command: "warm" }), { block: true, reason: "bash|warm|/srv/start|s-1|/sessions/s-1.jsonl" });
	const { value, lagMs } = await lagDuring(() => call("bash", { command: "busy git commit" }) as Promise<unknown>);
	assert.deepEqual(value, { block: true, reason: "bash|busy git commit|/srv/start|s-1|/sessions/s-1.jsonl" });
	assert.ok(lagMs < 50, `the 10 ms timer fired ${lagMs.toFixed(0)} ms late`);
});

test("each part of an ipython cell is judged with the cwd it runs in", async () => {
	const verdict = await call("ipython", { code: "allow = 1\nos.chdir('/srv/other')\nbash('busy git add a')" });
	assert.deepEqual(verdict, { block: true, reason: "ipython|os.chdir('/srv/other')\nbash('busy git add a')|/srv/other|s-1|/sessions/s-1.jsonl" });
	assert.equal(await call("ipython", { code: "allow = 1\nos.chdir('/srv/other')\nallow = 2" }), undefined);
});

test("a warn note the guard keeps from a tool_call reaches that call's tool_result", async () => {
	assert.equal(await call("bash", { command: "note this" }, "c-note"), undefined);
	const result = await handlers.get("tool_result")!({ type: "tool_result", toolCallId: "c-note", toolName: "bash", input: {}, content: [{ type: "text", text: "out" }], isError: false }, ctx);
	assert.deepEqual(result, { content: [{ type: "text", text: "out" }, { type: "text", text: "a note for note this" }] });
});

test("a judge that throws on the worker is judged on the loop, with one log line", async () => {
	assert.deepEqual(await call("bash", { command: "throws off the loop" }), { block: true, reason: "bash|throws off the loop|/srv/start|s-1|/sessions/s-1.jsonl" });
	const lines = readFileSync(logFile, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /worker did not judge a tool_call \(worker only\), so the loop judges it/);
});
