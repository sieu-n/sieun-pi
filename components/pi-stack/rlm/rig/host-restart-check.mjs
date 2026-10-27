#!/usr/bin/env node
// Restart a scratch pi-host under a running bash() job and a running pi-rlm child, and check that both survive.
// Run from components/pi-stack with RIG_DIR (agent/models.json with an sk-ant-oat01 placeholder key), EVIDENCE_DIR and optionally MODEL.
// The host runs as a systemd user unit, so its stop is the same SIGTERM a real restart or update sends.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HostClient } from "../../host/src/client.ts";

const stack = resolve(import.meta.dirname, "..", "..");
const rig = process.env.RIG_DIR;
const out = process.env.EVIDENCE_DIR;
const model = process.env.MODEL ?? "anthropic/claude-opus-5-5";
const socket = join(rig, "host.sock");
const ticks = join(rig, "ticks.log");
const unit = `pi-rlm-scratch-host-${Date.now().toString(36)}`;
mkdirSync(out, { recursive: true });
mkdirSync(join(rig, "ws"), { recursive: true });
const log = (o) => appendFileSync(join(out, "host-restart-events.jsonl"), JSON.stringify({ at: Date.now(), ...o }) + "\n");
writeFileSync(join(rig, "extensions.json"), JSON.stringify({ extensions: [join(stack, "agent-bus/index.ts"), join(stack, "harness/index.ts"), join(stack, "rlm/index.ts"), join(stack, "rlm/rig/async-token.ts")] }));

function startHost(n) {
  const env = ["HOME", "PATH", "USER", "LANG", "XDG_RUNTIME_DIR"].map(k => `${k}=${process.env[k] ?? ""}`);
  const args = ["--user", `--unit=${unit}-${n}`, "--collect", `--working-directory=${stack}`, ...env.flatMap(e => ["-E", e]), "-E", "PI_TELEMETRY=0", "-E", "PI_SKIP_VERSION_CHECK=1",
    "--property=StandardOutput=append:" + join(out, `host-${n}.log`), "--property=StandardError=append:" + join(out, `host-${n}.log`),
    process.execPath, "--import", "tsx", "host/src/main.ts", "--socket", socket, "--agent-dir", join(rig, "agent"), "--session-dir", join(rig, "sessions"), "--data-dir", join(rig, "data"),
    "--extensions-file", join(rig, "extensions.json"), "--cwd", join(rig, "ws"), "--model", model, "--idle-unload-min", "0"];
  const r = spawnSync("systemd-run", args, { encoding: "utf8" });
  log({ startHost: n, status: r.status, stderr: r.stderr });
}
const stopHost = (n) => log({ stopHost: n, ...spawnSync("systemctl", ["--user", "stop", `${unit}-${n}`], { encoding: "utf8" }) });
async function connect() {
  for (let i = 0; i < 300; i++) {
    try { return await HostClient.connect(socket); } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error("host socket never answered");
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const entries = (file) => readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
const text = (e) => JSON.stringify(e.message?.content ?? e.content ?? "");
function findFile(dir, pred) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(f => join(dir, String(f))).filter(f => f.endsWith(".jsonl") && pred(f));
}
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(1000); }
  throw new Error(`timed out: ${label}`);
}

const summary = { startedAt: new Date().toISOString(), model, checks: {} };
const check = (name, ok, detail) => { summary.checks[name] = { ok: !!ok, ...detail }; log({ check: name, ok: !!ok, detail }); };

startHost(1);
let client = await connect();
const created = await client.call({ type: "create", name: "restart-root", config: { cwd: join(rig, "ws") }, lifecycle: "resident" });
const rootId = created.activeSessionId;
const rootFile = created.sessionFile;
summary.rootId = rootId;
summary.rootFile = rootFile;
const childTask = [
  "Do these steps in order, each in its own ipython cell.",
  "1. Run: h = bash('sleep 40; echo child-job-done'); import os; print('child kernel', os.getpid(), h.pid)",
  "2. Run: import asyncio; await asyncio.sleep(15); print('child waited')",
  "3. End your turn with one short line. When the [bash-done ...] notice for h arrives, run r = h.poll() and then await agent_message.send(r.output.strip(), receiver_role='parent'), and stop.",
].join("\n");
const rootTask = [
  "Do this in one ipython cell and then end your turn with one short line:",
  `x = 41\njob = bash('for i in $(seq 1 45); do echo tick $i >> ${ticks}; sleep 1; done; echo job-done')\nimport os\nkernel_pid = os.getpid()\nchild = await rlm.spawn(${JSON.stringify(childTask)}, name='slow')\nprint('root kernel', kernel_pid, job.pid, child.rlm_child_id)`,
  "When the [bash-done ...] notice for job arrives, run print(x + 1, kernel_pid == os.getpid(), job.poll().output.strip()) in ipython and reply with the printed line.",
  "When the agent message from child slow arrives, reply with its text and no tool call.",
].join("\n\n");
await client.call({ type: "prompt", activeSessionId: rootId, message: rootTask });
const t0 = Date.now();
const childFile = await until(() => findFile(join(rig, "agent", "session-artifacts", rootId), f => /sub-[0-9a-f]{8}/.test(f))[0], 120_000, "child session file");
summary.childFile = childFile;
await until(() => existsSync(childFile) && entries(childFile).some(e => e.type === "message" && e.message.role === "toolResult" && text(e).includes("child kernel")), 120_000, "child step 1");
await until(() => entries(childFile).some(e => e.type === "message" && e.message.role === "assistant" && text(e).includes("asyncio.sleep")), 120_000, "child step 2 started");
const ticksBefore = existsSync(ticks) ? readFileSync(ticks, "utf8").trim().split("\n").length : 0;
const rootBefore = entries(rootFile).filter(e => e.type === "message" && e.message.role === "toolResult").map(text).join(" ");
const kernelPidBefore = /root kernel (\d+)/.exec(rootBefore)?.[1];
const childBefore = /child kernel (\d+)/.exec(entries(childFile).map(text).join(" "))?.[1];
log({ beforeStop: { ticksBefore, kernelPidBefore, childBefore, ms: Date.now() - t0 } });
client.close?.();

const stopAt = Date.now();
stopHost(1);
await sleep(3000);
const ticksWhileDown = existsSync(ticks) ? readFileSync(ticks, "utf8").trim().split("\n").length : 0;
const kernelAlive = kernelPidBefore ? spawnSync("kill", ["-0", kernelPidBefore]).status === 0 : false;
const childKernelAlive = childBefore ? spawnSync("kill", ["-0", childBefore]).status === 0 : false;
check("survives_stop", ticksWhileDown > ticksBefore && kernelAlive && childKernelAlive, { ticksBefore, ticksWhileDown, kernelPidBefore, kernelAlive, childBefore, childKernelAlive, downMs: Date.now() - stopAt });

startHost(2);
const restartAt = Date.now();
client = await connect();
const rootReopened = await until(async () => {
  const r = await client.request({ type: "list" });
  return (r.data?.sessions ?? r.data ?? []).some?.(s => (s.activeSessionId ?? s.sessionId) === rootId) ? Date.now() : undefined;
}, 60_000, "root reopened by its relay").catch(e => String(e));
check("root_reopened_by_relay", typeof rootReopened === "number", { ms: typeof rootReopened === "number" ? rootReopened - restartAt : rootReopened });

const jobDone = await until(() => {
  const es = entries(rootFile).filter(e => e.timestamp && Date.parse(e.timestamp) > restartAt);
  const notice = es.some(e => e.type === "custom_message" && e.customType === "async_bash_completion");
  const line = es.find(e => e.type === "message" && e.message.role === "toolResult" && text(e).includes("42 True"));
  return notice && line ? text(line) : undefined;
}, 240_000, "root job notice and 42 True").catch(e => String(e));
check("root_job_survived", /job-done/.test(jobDone) && /42 True/.test(jobDone), { tool: String(jobDone).slice(0, 300), ticks: readFileSync(ticks, "utf8").trim().split("\n").length });

const childResumed = entries(childFile).some(e => e.type === "custom_message" && e.customType === "rlm_resume");
const reply = await until(() => {
  const es = entries(rootFile).filter(e => e.type === "custom_message" && e.customType === "agent_message");
  const r = es.find(e => text(e).includes("child:slow") && text(e).includes("child-job-done"));
  return r ? text(r) : undefined;
}, 240_000, "child reply").catch(e => String(e));
check("child_survived_and_replied", childResumed && /child-job-done/.test(reply), { childResumed, reply: String(reply).slice(0, 300) });

client.close?.();
stopHost(2);
// A host stop leaves kernels under their relays on purpose; this rig is done with them, so end the relays it started.
log({ relaysEnded: spawnSync("pkill", ["-f", `${join(rig, "agent", "rlm", "kernel-venv", "bin", "python")} .*kernel_relay.py`]).status });
summary.endedAt = new Date().toISOString();
summary.ok = Object.values(summary.checks).every(c => c.ok);
writeFileSync(join(out, "host-restart-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
