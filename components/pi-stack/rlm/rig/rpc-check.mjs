#!/usr/bin/env node
// The step-2 real-provider check in `pi --mode rpc`: P1, P2 with 10 children, a compaction and a host restart, with RSS and
// event-loop lag sampled inside the pi process by rig/measure.ts. Run it from components/pi-stack with
// RIG_DIR (holds agent/models.json), EVIDENCE_DIR, and optionally MODEL (default anthropic/claude-opus-5-5) and THINKING.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname);
const stack = resolve(here, "..", "..");
const rig = process.env.RIG_DIR;
const out = process.env.EVIDENCE_DIR;
const [provider, ...rest] = (process.env.MODEL ?? "anthropic/claude-opus-5-5").split("/");
const model = rest.join("/");
const thinking = process.env.THINKING ?? "low";
const CHILDREN = Number(process.env.CHILDREN ?? 10);
mkdirSync(out, { recursive: true });
const eventsPath = join(out, "rpc-events.jsonl");
const measurePath = join(out, "rpc-measure.jsonl");
const summary = { startedAt: new Date().toISOString(), provider, model, thinking, children: CHILDREN, phases: {} };
const log = (o) => appendFileSync(eventsPath, JSON.stringify({ at: Date.now(), ...o }) + "\n");

function start(extra) {
  const args = [join(stack, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--mode", "rpc", "--provider", provider, "--model", model, "--thinking", thinking,
    "--tools", "ipython", "--no-context-files", "-e", join(stack, "rlm/index.ts"), "-e", join(stack, "agent-bus/index.ts"), "-e", join(stack, "rlm/rig/measure.ts"),
    ...(process.env.EXTRA_EXTENSIONS ?? "").split(",").filter(Boolean).flatMap(p => ["-e", resolve(stack, p)]),
    "--session-dir", join(rig, "sessions"), ...extra];
  const child = spawn(process.execPath, args, { cwd: join(rig, "ws"), env: { ...process.env, PI_RLM_MEASURE_LOG: measurePath, PI_RLM_MEASURE_LABEL: "rpc" }, stdio: ["pipe", "pipe", "pipe"] });
  const waiters = [];
  const seen = [];
  child.stderr.on("data", d => log({ stderr: String(d).slice(0, 2000) }));
  createInterface({ input: child.stdout }).on("line", line => {
    let e;
    try { e = JSON.parse(line); } catch { log({ raw: line.slice(0, 500) }); return; }
    if (e.type === "message_update" || e.type === "tool_execution_update") return;
    const m = e.message;
    const slim = { type: e.type, command: e.command, success: e.success, error: e.error, role: m?.role, customType: m?.customType, toolName: e.toolName,
      text: JSON.stringify(m?.content ?? e.result?.content ?? e.data ?? "").slice(0, 1500) };
    log(slim);
    seen.push({ ...e, at: Date.now() });
    for (const w of [...waiters]) if (w.match(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
  });
  let n = 0;
  const api = {
    child,
    seen,
    wait(match, ms = 600_000, label = "event") {
      const found = seen.find(match);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), ms);
        waiters.push({ match, resolve: (e) => { clearTimeout(t); res(e); } });
      });
    },
    async send(cmd) {
      const id = `d${++n}`;
      const p = new Promise((res) => waiters.push({ match: e => e.type === "response" && e.id === id, resolve: res }));
      child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
      return p;
    },
    settledCount: () => seen.filter(e => e.type === "agent_settled").length,
    async waitSettled(count, ms = 900_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (api.settledCount() >= count) {
          await new Promise(r => setTimeout(r, 3000));
          const last = seen.filter(e => e.type === "agent_settled").length;
          const lastStart = seen.map(e => e.type).lastIndexOf("agent_start");
          const lastSettle = seen.map(e => e.type).lastIndexOf("agent_settled");
          if (last >= count && lastSettle > lastStart) return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      throw new Error(`timed out waiting for ${count} settled runs, saw ${api.settledCount()}`);
    },
    toolTexts: () => seen.filter(e => e.type === "tool_execution_end").map(e => JSON.stringify(e.result?.content ?? "")),
    customs: (type) => seen.filter(e => e.type === "message_end" && e.message?.role === "custom" && e.message?.customType === type),
    async stop() {
      const exited = new Promise(r => child.once("exit", r));
      child.stdin.end();
      const t = setTimeout(() => child.kill("SIGTERM"), 30_000);
      await exited;
      clearTimeout(t);
    },
  };
  return api;
}

const check = (name, ok, detail) => { summary.phases[name] = { ok: !!ok, ...detail }; log({ check: name, ok: !!ok, detail }); if (!ok) console.error(`FAIL ${name}`, detail); };

const pi = start([]);
try {
  const state = await pi.send({ type: "get_state" });
  const sessionFile = state.data?.sessionFile;
  summary.sessionFile = sessionFile;

  // P1: state across cells and a background bash() notice that starts a new run.
  let t0 = Date.now();
  await pi.send({ type: "prompt", message: "Use the ipython tool. In one cell: set x = 41, set h = bash('sleep 12; echo bg-done'), and print h.pid. Do not await h or poll it. End your turn right after that cell with a one-line reply. Later, when a [bash-done ...] notice arrives, run print(h.poll().output, x + 1) in ipython and reply 'bg seen'." });
  await pi.waitSettled(1);
  await pi.waitSettled(2);
  const notice = pi.customs("async_bash_completion");
  const texts = pi.toolTexts();
  check("P1", notice.length >= 1 && texts.some(t => t.includes("bg-done") && t.includes("42")), { notices: notice.length, runs: pi.settledCount(), ms: Date.now() - t0, lastTool: texts.at(-1)?.slice(0, 300) });

  // P2: 10 children from one parent, each replying through agent_message.
  t0 = Date.now();
  const before = pi.settledCount();
  await pi.send({ type: "prompt", message: `Use the ipython tool. In one cell, run exactly this code and nothing else:\n\nimport time\nhandles = []\nadmit_ms = []\nfor i in range(${CHILDREN}):\n    s = time.monotonic()\n    handles.append(await rlm.spawn(f"In ipython compute {i} * {i} + 1. Then run await agent_message.send(str(that number), receiver_role='parent') and stop with a one-word answer.", name=f"w{i}"))\n    admit_ms.append(round((time.monotonic() - s) * 1000, 1))\nprint('admitted', len(handles), 'max_admit_ms', max(admit_ms), admit_ms)\n\nThen end your turn. Each child reply arrives as an [agent-message from child:...] message; answer each one with only the word ok and no tool call.` });
  const deadline = Date.now() + 900_000;
  const replies = () => pi.customs("agent_message").filter(e => /agent-message from child:w\d/.test(JSON.stringify(e.message.content)));
  while (replies().length < CHILDREN && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));
  await pi.waitSettled(before + 1);
  const admit = pi.toolTexts().find(t => t.includes("max_admit_ms"));
  const got = replies().map(e => JSON.stringify(e.message.content));
  const want = Array.from({ length: CHILDREN }, (_, i) => `${i * i + 1}`);
  const ok = want.every((v, i) => got.some(g => g.includes(`child:w${i}`) && g.includes(v)));
  check("P2_children", ok, { replies: got.length, ms: Date.now() - t0, admit: admit?.slice(0, 400), terminalNotices: pi.customs("rlm_child_terminal_notice").length, failures: pi.customs("rlm_child_failure").length });

  // Revival after a compaction: the kernel process stays, so the namespace is untouched.
  t0 = Date.now();
  const c = await pi.send({ type: "compact" });
  const settledBefore = pi.settledCount();
  await pi.send({ type: "prompt", message: "In ipython run print(x + 1, len(handles), sorted(h.name for h in handles)[:3]) and reply with the printed line." });
  await pi.waitSettled(settledBefore + 1);
  const afterCompact = pi.toolTexts().at(-1);
  check("revive_after_compaction", c.success && afterCompact?.includes(`42 ${CHILDREN}`), { compactOk: c.success, compactError: c.error, ms: Date.now() - t0, tool: afterCompact?.slice(0, 300), pythonStateNote: pi.customs("ipython_state").length });
} finally {
  await pi.stop();
}

// Revival after a host restart: a new pi process opens the same session file and restores kernel-state.dill.
const pi2 = start(["--session", summary.sessionFile]);
try {
  const t0 = Date.now();
  await pi2.send({ type: "prompt", message: "In ipython run print(x + 1, len(handles)) and then rows = await rlm.list_subagents(); print(len(rows)). Reply with both printed lines." });
  await pi2.waitSettled(1);
  const tools = pi2.toolTexts();
  const first = pi2.seen.find(e => e.type === "tool_execution_end");
  check("revive_after_restart", tools.some(t => t.includes(`42 ${CHILDREN}`)) && tools.some(t => t.includes("python-state-restored")), { ms: Date.now() - t0, firstToolAt: first ? first.at - t0 : null, tools: tools.map(t => t.slice(0, 400)) });
} finally {
  await pi2.stop();
}

const samples = readFileSync(measurePath, "utf8").trim().split("\n").map(l => JSON.parse(l));
const max = (k) => Math.max(...samples.map(s => s[k]));
const pct = (k, p) => { const v = samples.map(s => s[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };
summary.measure = { samples: samples.length, rssMaxMb: max("rssMb"), heapMaxMb: max("heapMb"), lagP99OfSamplesMs: pct("lagP99Ms", 0.5), lagP99WorstMs: max("lagP99Ms"), lagMaxMs: max("lagMaxMs") };
summary.endedAt = new Date().toISOString();
summary.ok = Object.values(summary.phases).every(p => p.ok);
writeFileSync(join(out, "rpc-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
