// The step-2 real-provider check in an in-process runtime from pi-testkit/faux.ts: the same phases as rpc-check.mjs, with the sampler in this
// process. Phase "run" does P1, P2 with CHILDREN children and a compaction; phase "restart" runs in a fresh Node process and reopens the
// session file. Run from packages: node --import tsx pi-rlm/rig/inprocess-check.ts, with RIG_DIR, EVIDENCE_DIR and MODEL.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { openRuntime } from "@sieun-pi/pi-testkit/faux";
import agentBus from "../agent-bus/index.ts";
import piRlm, { setChildLoaderOptions } from "../index.ts";
import measure, { startSampler } from "./measure.ts";

const rig = process.env.RIG_DIR!;
const out = process.env.EVIDENCE_DIR!;
const phase = process.argv[2] ?? "run";
const [provider, ...rest] = (process.env.MODEL ?? "anthropic/claude-opus-5-5").split("/");
const modelId = rest.join("/");
const CHILDREN = Number(process.env.CHILDREN ?? 10);
const root = join(rig, "inproc");
mkdirSync(join(root, "agent"), { recursive: true });
for (const f of ["models.json", "settings.json"]) if (existsSync(join(rig, "agent", f))) copyFileSync(join(rig, "agent", f), join(root, "agent", f));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(out, { recursive: true });
const eventsPath = join(out, "inproc-events.jsonl");
const measurePath = join(out, "inproc-measure.jsonl");
const summaryPath = join(out, "inproc-summary.json");
const log = (o: unknown) => appendFileSync(eventsPath, JSON.stringify({ at: Date.now(), phase, ...(o as object) }) + "\n");
startSampler(measurePath, `inproc-${phase}`);

const extra = await Promise.all((process.env.EXTRA_EXTENSIONS ?? "").split(",").filter(Boolean).map(async p => (await import(resolve(import.meta.dirname, "..", "..", p))).default));
setChildLoaderOptions(() => ({ extensionFactories: [...extra, agentBus, piRlm, measure], noContextFiles: true, noPromptTemplates: true, noThemes: true }));

async function open(sessionFile?: string): Promise<AgentSessionRuntime> {
  const rt = await openRuntime({ root, sessionFile, extensionFactories: [...extra, agentBus, piRlm, measure] });
  const model = rt.services.modelRuntime.getModel(provider!, modelId);
  if (!model) throw new Error(`no model ${provider}/${modelId} in ${root}/agent/models.json`);
  await rt.session.setModel(model);
  rt.session.setThinkingLevel((process.env.THINKING ?? "low") as never);
  rt.session.setActiveToolsByName?.(["ipython"]);
  rt.session.subscribe(e => {
    if (e.type === "message_update" || e.type === "tool_execution_update") return;
    const m = (e as { message?: { role?: string; customType?: string; content?: unknown } }).message;
    log({ type: e.type, role: m?.role, customType: m?.customType, text: JSON.stringify(m?.content ?? (e as { result?: { content?: unknown } }).result?.content ?? "").slice(0, 1500) });
  });
  return rt;
}

async function idle(rt: AgentSessionRuntime, ms = 900_000): Promise<void> {
  const deadline = Date.now() + ms;
  let quiet = 0;
  while (Date.now() < deadline) {
    quiet = rt.session.isStreaming ? 0 : quiet + 1;
    if (quiet >= 6) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for the session to go idle");
}

const toolTexts = (rt: AgentSessionRuntime) => rt.session.sessionManager.getEntries().filter(e => e.type === "message" && e.message.role === "toolResult").map(e => JSON.stringify((e as { message: { content: unknown } }).message.content));
const customs = (rt: AgentSessionRuntime, type: string) => rt.session.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === type).map(e => JSON.stringify((e as { content: unknown }).content));

const summary: Record<string, unknown> = phase === "run" ? { startedAt: new Date().toISOString(), provider, modelId, children: CHILDREN, phases: {} } : JSON.parse(readFileSync(summaryPath, "utf8"));
const phases = summary.phases as Record<string, unknown>;
const check = (name: string, ok: boolean, detail: Record<string, unknown>) => {
  phases[name] = { ok, ...detail };
  log({ check: name, ok, detail });
};

if (phase === "run") {
  const rt = await open();
  summary.sessionFile = rt.session.sessionManager.getSessionFile();
  let t0 = Date.now();
  await rt.session.prompt("Use the ipython tool. In one cell: set x = 41, set h = bash('sleep 12; echo bg-done'), and print h.pid. Do not await h or poll it. End your turn right after that cell with a one-line reply. Later, when a [bash-done ...] notice arrives, run print(h.poll().output, x + 1) in ipython and reply 'bg seen'.");
  const deadline1 = Date.now() + 300_000;
  while (!customs(rt, "async_bash_completion").length && Date.now() < deadline1) await new Promise(r => setTimeout(r, 500));
  await idle(rt);
  check("P1", customs(rt, "async_bash_completion").length >= 1 && toolTexts(rt).some(t => t.includes("bg-done") && t.includes("42")), { ms: Date.now() - t0, lastTool: toolTexts(rt).at(-1)?.slice(0, 300) });

  t0 = Date.now();
  await rt.session.prompt(`Use the ipython tool. In one cell, run exactly this code and nothing else:\n\nimport time\nhandles = []\nadmit_ms = []\nfor i in range(${CHILDREN}):\n    s = time.monotonic()\n    handles.append(await rlm.spawn(f"In ipython compute {i} * {i} + 1. Then run await agent_message.send(str(that number), receiver_role='parent') and stop with a one-word answer.", name=f"w{i}"))\n    admit_ms.append(round((time.monotonic() - s) * 1000, 1))\nprint('admitted', len(handles), 'max_admit_ms', max(admit_ms), admit_ms)\n\nThen end your turn. Each child reply arrives as an [agent-message from child:...] message; answer each one with only the word ok and no tool call.`);
  const replies = () => customs(rt, "agent_message").filter(t => /agent-message from child:w\d/.test(t));
  const deadline2 = Date.now() + 900_000;
  while (replies().length < CHILDREN && Date.now() < deadline2) await new Promise(r => setTimeout(r, 1000));
  await idle(rt);
  const got = replies();
  const ok = Array.from({ length: CHILDREN }, (_, i) => `${i * i + 1}`).every((v, i) => got.some(g => g.includes(`child:w${i}`) && g.includes(v)));
  check("P2_children", ok, { replies: got.length, ms: Date.now() - t0, admit: toolTexts(rt).find(t => t.includes("max_admit_ms"))?.slice(0, 400), terminalNotices: customs(rt, "rlm_child_terminal_notice").length, failures: customs(rt, "rlm_child_failure").length });

  t0 = Date.now();
  let compactError: string | undefined;
  await rt.session.compact().catch(e => (compactError = String(e)));
  await rt.session.prompt("In ipython run print(x + 1, len(handles), sorted(h.name for h in handles)[:3]) and reply with the printed line.");
  await idle(rt);
  const after = toolTexts(rt).at(-1);
  check("revive_after_compaction", !compactError && !!after?.includes(`42 ${CHILDREN}`), { compactError, ms: Date.now() - t0, tool: after?.slice(0, 300) });
  await rt.dispose();
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  const second = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "restart"], { env: process.env, stdio: "inherit" });
  process.exit(second.status ?? 1);
} else {
  const t0 = Date.now();
  const rt = await open(summary.sessionFile as string);
  const reopenMs = Date.now() - t0;
  await rt.session.prompt("In ipython run print(x + 1, len(handles)) and then rows = await rlm.list_subagents(); print(len(rows)). Reply with both printed lines.");
  await idle(rt);
  const tools = toolTexts(rt).slice(-3);
  check("revive_after_restart", tools.some(t => t.includes(`42 ${CHILDREN}`)) && tools.some(t => t.includes("python-state-restored")), { reopenMs, ms: Date.now() - t0, tools: tools.map(t => t.slice(0, 400)) });
  await rt.dispose();
  const samples = readFileSync(measurePath, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, number>);
  const max = (k: string) => Math.max(...samples.map(s => s[k]!));
  summary.measure = { samples: samples.length, rssMaxMb: max("rssMb"), heapMaxMb: max("heapMb"), lagP99WorstMs: max("lagP99Ms"), lagMaxMs: max("lagMaxMs") };
  summary.endedAt = new Date().toISOString();
  summary.ok = Object.values(phases).every(p => (p as { ok: boolean }).ok);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
