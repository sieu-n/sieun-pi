/**
 * Scale probe for pi-host (research daemon.md, claim 1): open copies of real sessions in one host, stream several at once against a local
 * mock OpenAI endpoint, and record RSS and `monitorEventLoopDelay` p99 for each phase. It writes one JSON report.
 *
 *   node --import tsx pi-host/probes/scale.ts --sessions <dir> --agent-dir <dir> --cwd <dir> --socket <path> --out <file.json>
 *     [--stream 10] [--no-attach] [--warm] [--extension <path>]...
 *
 * `--warm` imports the provider modules before the sessions open (`PiHost.warmProviders`).
 * Unless `--no-attach`, a socket client attaches to the largest session with a chunked snapshot while the streams run.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { HostClient } from "../src/client.ts";
import { installGuard } from "../src/guard.ts";
import { PiHost } from "../src/host.ts";
import { listen } from "../src/server.ts";
import type { HostedSession } from "../src/session.ts";

const { values } = parseArgs({ options: {
  sessions: { type: "string" }, "agent-dir": { type: "string" }, cwd: { type: "string" }, socket: { type: "string" }, out: { type: "string" },
  stream: { type: "string" }, "no-attach": { type: "boolean" }, warm: { type: "boolean" }, extension: { type: "string", multiple: true }, chunks: { type: "string" }, gap: { type: "string" },
} });
const sessionsDir = resolve(values.sessions!);
const agentDir = resolve(values["agent-dir"]!);
const cwd = resolve(values.cwd!);
const streamCount = Number(values.stream ?? 10);
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const key of Object.keys(process.env)) if (key.startsWith("PRIME_AGENT_") || key.startsWith("RLM_")) delete process.env[key];

const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;
const ms = (ns: number) => Math.round(ns / 1e4) / 100;
const memory = () => { const m = process.memoryUsage(); return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), externalMb: mb(m.external) }; };

const mock = spawn(process.execPath, [fileURLToPath(new URL("./mock-openai.mjs", import.meta.url)), "0", values.chunks ?? "60", values.gap ?? "40"], { stdio: ["ignore", "pipe", "pipe"] });
let mockLog = "";
mock.stderr.on("data", chunk => { mockLog += chunk; });
const port = await new Promise<number>(done => mock.stdout.once("data", chunk => done(Number(String(chunk).trim()))));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: {
  baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "mock",
  models: [{ id: "mock-1", name: "mock-1", reasoning: false, input: ["text"], contextWindow: 50_000_000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }, null, 1));

const report: Record<string, unknown> = { at: new Date().toISOString(), node: process.version, pid: process.pid, extensions: values.extension ?? [], mockPort: port };
const host = new PiHost({ agentDir, defaultCwd: cwd, extensions: (values.extension ?? []).map(path => resolve(path)), idleUnloadMs: 0, log: line => process.stderr.write(`${line}\n`) });
installGuard(host);
const server = await listen(host, resolve(values.socket!));
report.baseline = memory();
if (values.warm) report.warm = await host.warmProviders();

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const phase = () => { const out = { p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max), samples: histogram.count }; histogram.reset(); return out; };
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);

const files = readdirSync(sessionsDir).filter(name => name.endsWith(".jsonl")).map(name => join(sessionsDir, name))
  .sort((a, b) => statSync(b).size - statSync(a).size);
const opened: { file: string; mb: number; ms: number; messages: number; session: HostedSession }[] = [];
const failures: { file: string; error: string }[] = [];
const openStart = performance.now();
for (const file of files) {
  const start = performance.now();
  try {
    const session = await host.openSession({ sessionPath: file, provider: "mock", model: "mock-1" });
    opened.push({ file, mb: mb(statSync(file).size), ms: Math.round(performance.now() - start), messages: session.session.messages.length, session });
  } catch (error) {
    failures.push({ file, error: error instanceof Error ? error.message : String(error) });
  }
}
report.open = { count: opened.length, failures, totalMs: Math.round(performance.now() - openStart), totalFileMb: Math.round(opened.reduce((sum, row) => sum + row.mb, 0) * 10) / 10,
  slowest: [...opened].sort((a, b) => b.ms - a.ms).slice(0, 5).map(({ file, mb, ms, messages }) => ({ file: file.split("/").pop(), mb, ms, messages })),
  memory: memory(), peakRssMb: mb(peakRss), loop: phase() };
peakRss = 0;
global.gc?.();

const streaming = opened.slice(0, streamCount);
const attachClient = await HostClient.connect(resolve(values.socket!));
const streamStart = performance.now();
const attachStart = performance.now();
const attach = values["no-attach"] ? Promise.resolve(-1) : attachClient.call({ type: "attach", activeSessionId: streaming[0].session.id, capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"] })
  .then(() => attachClient.waitFor(line => line.type === "session_snapshot_end", 60_000)).then(() => Math.round(performance.now() - attachStart));
const results = await Promise.all(streaming.map(async row => {
  const start = performance.now();
  await host.startPrompt(row.session, "Reply with a few words. This is a pi-host scale probe.");
  await row.session.session.waitForIdle();
  const text = row.session.session.getLastAssistantText() ?? "";
  return { file: row.file.split("/").pop(), mb: row.mb, ms: Math.round(performance.now() - start), ok: text.startsWith("word "), chars: text.length };
}));
const attachMs = await attach;
report.stream = { count: streaming.length, wallMs: Math.round(performance.now() - streamStart), allAnswered: results.every(row => row.ok), results,
  attachLargestDuringStreamMs: attachMs, attachedSnapshotChunks: attachClient.lines.filter(line => line.type === "session_snapshot_chunk").length,
  memory: memory(), peakRssMb: mb(peakRss), loop: phase() };
attachClient.close();

report.mockRequests = mockLog.trim().split("\n").filter(Boolean).length;
report.mockLargestBodyMb = mb(Math.max(...mockLog.split("\n").map(line => Number(/body (\d+)/.exec(line)?.[1] ?? 0))));
report.faults = host.faults.length;
clearInterval(sampler);
const shutdownStart = performance.now();
await host.shutdown();
report.shutdownMs = Math.round(performance.now() - shutdownStart);
server.close();
mock.kill();
writeFileSync(resolve(values.out!), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);
