import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, openRuntime, type FauxReply } from "../../pi-testkit/faux.ts";
import agentBus from "../agent-bus/index.ts";
import { list as registryList } from "../../pi-family/registry.ts";
import piRlm, { setChildLoaderOptions } from "../index.ts";
import { openWithSkills, testPython } from "./helpers.ts";

type Ctx = { messages: { role: string; content: unknown; customType?: string }[] };
const R = (m: AssistantMessage): FauxReply => () => m;
const cell = (code: string) => R(fauxAssistantMessage(fauxToolCall("ipython", { code })));
const say = (text: string) => R(fauxAssistantMessage([fauxText(text)]));
const step = (f: (c: Ctx) => AssistantMessage) => f as unknown as FauxReply;
const lastText = (c: Ctx) => JSON.stringify(c.messages.at(-1)?.content ?? "");

let root: string;
before(async () => {
  await testPython();
  root = mkdtempSync(join(tmpdir(), "pi-rlm-ext-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.RLM_MAX_DEPTH = "2";
});
after(() => {
  setChildLoaderOptions(undefined);
  rmSync(root, { recursive: true, force: true });
});

function smallCompaction(dir: string): void {
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
}

async function settle(rt: AgentSessionRuntime, provider: ReturnType<typeof fauxProvider>, left: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (provider.core.getPendingResponseCount() <= left && !rt.session.isStreaming) {
      await new Promise(r => setTimeout(r, 200));
      if (provider.core.getPendingResponseCount() <= left && !rt.session.isStreaming) return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out with ${provider.core.getPendingResponseCount()} faux replies left`);
}

function toolTexts(rt: AgentSessionRuntime): string[] {
  return rt.session.messages.filter(m => m.role === "toolResult").map(m => JSON.stringify((m as { content: unknown }).content));
}

test("P1: state across cells, live output, and a finished bash() handle starts a new run", async () => {
  const faux = fauxProvider();
  const sentinel = "unused";
  faux.queue([
    cell("x = 41\nh = bash('sleep 1; echo bg-done')\nprint('started', h.pid)"),
    cell("import asyncio\nfor i in range(3):\n    print('tick', i, flush=True)\n    await asyncio.sleep(0.1)\nx + 1"),
    say("waiting for the background command"),
    step(c => fauxAssistantMessage(lastText(c).includes("bash-done") ? fauxToolCall("ipython", { code: "print(h.poll())" }) : fauxText("no notice"))),
    say("probe done"),
    sentinel,
  ]);
  const rt = await openRuntime({ root: join(root, "p1"), provider: faux, extensionFactories: [piRlm] });
  const updates: number[] = [];
  rt.session.subscribe(e => {
    if (e.type === "tool_execution_update" && e.toolName === "ipython") updates.push(Date.now());
  });
  try {
    await rt.session.prompt("go");
    await settle(rt, faux, 1);
    const texts = toolTexts(rt);
    assert.match(texts[1]!, /tick 2/);
    assert.match(texts[1]!, /42/);
    assert.match(texts[2]!, /bg-done/);
    assert.ok(updates.length >= 3, `expected live updates, got ${updates.length}`);
    const notice = rt.session.messages.find(m => m.role === "custom" && (m as { customType?: string }).customType === "async_bash_completion");
    assert.ok(notice, "the bash-done notice is in the transcript");
    assert.equal(rt.session.getLastAssistantText(), "probe done");
  } finally {
    await rt.dispose();
  }
});

test("a handle read in a later cell of the same run sends no notice", async () => {
  const faux = fauxProvider();
  faux.queue([
    cell("h = bash('sleep 0.3; echo quick')\nh.pid"),
    cell("import asyncio\nawait asyncio.sleep(1.5)\nprint(h.poll().output)"),
    say("read it myself"),
    "extra run",
  ]);
  const rt = await openRuntime({ root: join(root, "withdraw"), provider: faux, extensionFactories: [piRlm] });
  try {
    await rt.session.prompt("go");
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(faux.core.getPendingResponseCount(), 1, "no extra run started");
    assert.ok(!rt.session.messages.some(m => (m as { customType?: string }).customType === "async_bash_completion"));
  } finally {
    await rt.dispose();
  }
});

test("P2: rlm.spawn returns at once, the child's reply steers the parent, and a silent child sends a no-reply notice", async () => {
  const childFaux = fauxProvider();
  childFaux.queue([
    cell("r = await agent_message.send('four', receiver_role='parent')\ng = await goal.get()\nprint(r['deliveryStatus'] if isinstance(r, dict) else r, g['goal'])"),
    say("sent"),
    say("I am the quiet child"),
  ]);
  setChildLoaderOptions(() => ({ extensionFactories: [childFaux.factory, agentBus, piRlm], noContextFiles: true, noPromptTemplates: true, noThemes: true }));
  const faux = fauxProvider();
  let spawnedAt = 0;
  faux.queue([
    step(() => {
      spawnedAt = Date.now();
      return fauxAssistantMessage(fauxToolCall("ipython", { code: "import time\nt0 = time.monotonic()\nh = await rlm.spawn('what is 2+2', name='worker')\nprint(h.name, h.rlm_child_id, round(time.monotonic() - t0, 3))" }));
    }),
    say("parent waits"),
    step(c => fauxAssistantMessage(lastText(c).includes("agent-message from child:worker") ? "got four" : "no reply seen")),
    cell("q = await rlm.spawn('stay quiet', name='quiet')\nrows = await rlm.list_subagents()\nprint(sorted(r.session_name for r in rows))"),
    say("parent waits again"),
    step(c => fauxAssistantMessage(lastText(c).includes("child-exited: no-reply child:quiet") ? "quiet noticed" : "no notice")),
    cell("res = await rlm.collect(timeout_ms=5000)\nprint(sorted((r.session_name, r.status, r.answer_preview) for r in res))\nd = await rlm.delete_subagent('quiet')\nprint(d.session_name, len(await rlm.list_subagents()))"),
    say("all done"),
    "unused",
  ]);
  const rt = await openWithSkills({ root: join(root, "p2"), provider: faux, extensionFactories: [agentBus, piRlm] });
  try {
    await rt.session.prompt("spawn");
    await settle(rt, faux, 6);
    const spawnOut = toolTexts(rt)[0]!;
    assert.match(spawnOut, /worker sub-[0-9a-f]{8}/);
    const seconds = Number(/ (\d+\.\d+)\\n/.exec(spawnOut)?.[1]);
    assert.ok(seconds < 1, `spawn admitted in ${seconds}s`);
    assert.ok(spawnedAt > 0);
    assert.equal(rt.session.getLastAssistantText(), "got four");
    const childDir = join(process.env.PI_CODING_AGENT_DIR!, "session-artifacts", rt.session.sessionManager.getSessionId());
    const childFile = readdirSync(childDir).filter(d => d.startsWith("sub-")).flatMap(d => readdirSync(join(childDir, d)).filter(f => f.endsWith(".jsonl")).map(f => join(childDir, d, f)))[0]!;
    const childLog = readFileSync(childFile, "utf8");
    assert.match(childLog, /\[task from parent\]/);
    assert.equal(JSON.parse(childLog.split("\n")[0]!).parentSession, rt.session.sessionManager.getSessionFile());
    assert.match(childLog, /(delivered|queued|started)[^"]* None/, "agent_message and goal are pre-imported in the child kernel");
    await rt.session.prompt("spawn a quiet one");
    await settle(rt, faux, 3);
    assert.equal(rt.session.getLastAssistantText(), "quiet noticed");
    await rt.session.prompt("collect");
    await settle(rt, faux, 1);
    const collected = toolTexts(rt).at(-1)!;
    assert.match(collected, /\('quiet', 'done', 'I am the quiet child'\)/);
    assert.match(collected, /quiet 1/);
    assert.ok(!registryList().some(a => a.name === "quiet"), "deleting a child runs its session_shutdown, so pi-agent-bus drops it");
  } finally {
    await rt.dispose();
  }
});

test("the namespace survives a compaction in the same kernel and a restart through the snapshot", async () => {
  const faux = fauxProvider();
  faux.queue([cell("x = 41\nnotes = ['kept']"), say("set")]);
  const dir = join(root, "revive");
  smallCompaction(dir);
  const rt = await openRuntime({ root: dir, provider: faux, extensionFactories: [piRlm] });
  const file = rt.session.sessionManager.getSessionFile()!;
  await rt.session.prompt("set x");
  await settle(rt, faux, 0);
  faux.queue(["summary of the work so far", cell("print(x + 1, notes)"), say("still there")]);
  await rt.session.compact();
  await rt.session.prompt("after compaction");
  await settle(rt, faux, 0);
  assert.match(toolTexts(rt).at(-1)!, /42 \['kept'\]/);
  const state = rt.session.messages.find(m => (m as { customType?: string }).customType === "ipython_state");
  assert.ok(state, "the [python-state] note follows the compaction");
  await rt.dispose();

  const faux2 = fauxProvider();
  faux2.queue([cell("print(x + 1, notes)"), say("revived")]);
  const rt2 = await openRuntime({ root: dir, sessionFile: file, provider: faux2, extensionFactories: [piRlm] });
  try {
    await rt2.session.prompt("after restart");
    await settle(rt2, faux2, 0);
    const out = toolTexts(rt2).at(-1)!;
    assert.match(out, /python-state-restored/);
    assert.match(out, /42 \['kept'\]/);
  } finally {
    await rt2.dispose();
  }
});

test("goal and compact bridges: compact.run compacts at the turn end and resumes the run", async () => {
  const faux = fauxProvider();
  faux.queue([
    cell("from rlm import host_request\ng = await host_request('goal.create', {'objective': 'ship it', 'token_budget': 100000})\nprint(g['goal']['status'])"),
    cell("from rlm import host_request\nprint(await host_request('compact.run', {'instructions': 'keep the goal'}))"),
    say("ending the turn so compaction runs"),
    "summary after compact.run",
    step(c => JSON.stringify(c.messages).includes("compaction-resume") ? fauxAssistantMessage(fauxToolCall("ipython", { code: "from rlm import host_request\nprint((await host_request('goal.complete'))['goal']['status'])" })) : fauxAssistantMessage("not resumed")),
    say("resumed"),
    "unused",
  ]);
  smallCompaction(join(root, "bridges"));
  const rt = await openRuntime({ root: join(root, "bridges"), provider: faux, extensionFactories: [piRlm] });
  try {
    await rt.session.prompt("goal then compact");
    await settle(rt, faux, 1);
    assert.match(JSON.stringify(rt.session.sessionManager.getEntries()), /active/);
    assert.equal(rt.session.getLastAssistantText(), "resumed");
    assert.ok(rt.session.sessionManager.getEntries().some(e => e.type === "compaction"));
    assert.ok(!rt.session.sessionManager.getEntries().some(e => e.type === "custom_message" && e.customType === "goal_context"), "a pending compaction holds the goal continuation");
  } finally {
    await rt.dispose();
  }
});

test("a cell that ignores the interrupt makes the next call ask to wait or restart, and both choices work", async () => {
  process.env.PI_RLM_INTERRUPT_GRACE_MS = "300";
  const asked: string[] = [];
  let answer = "Wait and preserve state";
  const faux = fauxProvider();
  const stubborn = "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ny = 5\ntime.sleep(2.5)";
  faux.queue([cell(stubborn), "unused after abort", cell("print('y is', y)"), say("waited"), cell(stubborn), "unused after abort", cell("print('y' in globals())"), say("restarted"), "spare"]);
  const rt = await openWithSkills({
    root: join(root, "busy"),
    provider: faux,
    extensionFactories: [piRlm],
    select: async (title, options) => {
      asked.push(title.split("\n")[0]!);
      assert.deepEqual(options, ["Wait and preserve state", "Kill kernel and restart"]);
      return answer;
    },
  });
  try {
    const run = rt.session.prompt("stubborn cell");
    await new Promise(r => setTimeout(r, 1200));
    await rt.session.abort();
    await run.catch(() => undefined);
    assert.match(toolTexts(rt).at(-1)!, /ipython_interrupt_pending/);
    faux.core.setResponses([]);
    faux.queue([cell("print('y is', y)"), say("waited"), cell(stubborn), "unused", cell("print('y' in globals())"), say("restarted"), "spare"]);
    await rt.session.prompt("read y");
    await settle(rt, faux, 5);
    assert.deepEqual(asked, ["Interrupted Python cell is still running"]);
    assert.match(toolTexts(rt).at(-1)!, /y is 5/);

    answer = "Kill kernel and restart";
    const run2 = rt.session.prompt("stubborn again");
    await new Promise(r => setTimeout(r, 1200));
    await rt.session.abort();
    await run2.catch(() => undefined);
    faux.core.setResponses([]);
    faux.queue([cell("print('y' in globals())"), say("restarted"), "spare"]);
    await rt.session.prompt("check y");
    await settle(rt, faux, 1);
    assert.equal(asked.length, 2);
    const out = toolTexts(rt).at(-1)!;
    assert.match(out, /ipython_kernel_reset/);
  } finally {
    delete process.env.PI_RLM_INTERRUPT_GRACE_MS;
    await rt.dispose();
  }
});
