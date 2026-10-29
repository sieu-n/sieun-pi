/**
 * pi-host CLI:
 *
 *   node --import tsx pi-host/src/main.ts --socket <path> --agent-dir <dir> [--session-dir <dir>] [--data-dir <dir>] [--extension <path>]... [--cwd <dir>]
 *     [--model <provider/id>] [--idle-unload-min <n>] [--scratch-chat] [--extensions-file <path>] [--no-default-extensions] [--durable-dir <dir>] [--no-durable]
 *
 * Every session loads the extensions listed in `pi-host/extensions.json` (paths relative to that file), then each `--extension`, which repeats.
 * `--extensions-file` names another list, and `--no-default-extensions` skips the list. `--scratch-chat` marks the hello so a scratch chat serve passes writes. SIGTERM and
 * SIGINT dispose every session, release every lease, remove the socket and exit 0.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableSettings, poolProvider, TurnQueue } from "@sieun-pi/pi-pool/durable";
import { DurableCommands, DurableThreads } from "./durable/index.ts";
import { loadPrimeChat, type PrimeChat } from "./durable/prime-chat.ts";
import { promptTools } from "./durable/prime-prompt.ts";
import { DurableRlm } from "./durable/rlm.ts";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOST_SOCKET_ENV } from "./api.ts";
import { installGuard } from "./guard.ts";
import { PiHost } from "./host.ts";
import schedulerExtension from "./scheduler-extension.ts";
import { listen } from "./server.ts";

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    "agent-dir": { type: "string" },
    "session-dir": { type: "string" },
    "data-dir": { type: "string" },
    extension: { type: "string", multiple: true },
    cwd: { type: "string" },
    model: { type: "string" },
    "idle-unload-min": { type: "string" },
    "scratch-chat": { type: "boolean" },
    "extensions-file": { type: "string" },
    "no-default-extensions": { type: "boolean" },
    "durable-dir": { type: "string" },
    "no-durable": { type: "boolean" },
  },
});

if (!values.socket || !values["agent-dir"]) {
  process.stderr.write("usage: main.ts --socket <path> --agent-dir <dir> [--session-dir <dir>] [--data-dir <dir>] [--extension <path>]... [--cwd <dir>] [--model <provider/id>] [--idle-unload-min <n>] [--scratch-chat]\n");
  process.exit(2);
}

const socketPath = resolve(values.socket);
const agentDir = resolve(values["agent-dir"]);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env[HOST_SOCKET_ENV] = socketPath;
/** `{ "extensions": ["../pi-rlm/src/pi/agent-bus.ts", ...] }`, each path relative to the list file. */
function listedExtensions(): string[] {
  if (values["no-default-extensions"]) return [];
  const file = values["extensions-file"] ? resolve(values["extensions-file"]) : fileURLToPath(new URL("../extensions.json", import.meta.url));
  if (!existsSync(file)) return [];
  const list = (JSON.parse(readFileSync(file, "utf8")) as { extensions?: unknown }).extensions;
  if (!Array.isArray(list) || list.some(entry => typeof entry !== "string")) throw new Error(`${file}: needs {"extensions": [<path>, ...]}`);
  return list.map(entry => resolve(dirname(file), entry as string));
}
const extensions = [...listedExtensions(), ...(values.extension ?? []).map(path => resolve(path))];

const [provider, ...modelId] = (values.model ?? "").split("/");

// pi-rlm children load the host's extensions plus the scheduler's, so a child's rlm_heartbeat jobs attach to this host's scheduler.
const { setChildLoaderOptions } = await import("@sieun-pi/pi-rlm/children");
setChildLoaderOptions(() => ({ additionalExtensionPaths: extensions, extensionFactories: [schedulerExtension] }));

const dataDir = values["data-dir"] ? resolve(values["data-dir"]) : join(agentDir, "pi-host");
// Durable threads: one pi-durable file per root thread, each its own pi-pool tree. The default model is the newest Opus (c185).
// One line for every run on the box (pi-pool's turn queue): each durable request takes its run's place, and a settled input gives it back.
const turns = new TurnQueue({ agentDir });
// Prime's chat extension (user-history), loaded once as a chat: every thread's root conversation offers its tools and turn wrappers.
// PI_HOST_PRIME_CHAT=0 leaves it out; a failed load leaves it out too, and the host says so in its log.
let chat: PrimeChat | undefined;
if (!values["no-durable"] && process.env.PI_HOST_PRIME_CHAT !== "0") {
  chat = await loadPrimeChat({ agentDir, log: line => process.stderr.write(`${line}\n`) })
    .catch(error => { process.stderr.write(`prime chat extension failed to load: ${error instanceof Error ? error.stack : String(error)}\n`); return undefined; });
}
// Prime's ipython in every durable conversation, one kernel each, freed after the threads' idle close time. PI_HOST_RLM=0 leaves it out,
// and a failed load leaves it out too, which the host log says.
let rlm: DurableRlm | undefined;
if (!values["no-durable"] && process.env.PI_HOST_RLM !== "0") {
  rlm = await DurableRlm.load({ agentDir, log: line => process.stderr.write(`${line}\n`) })
    .catch(error => { process.stderr.write(`durable ipython failed to load: ${error instanceof Error ? error.stack : String(error)}\n`); return undefined; });
}
const durable = values["no-durable"] ? undefined : new DurableCommands(new DurableThreads({
  dir: values["durable-dir"] ? resolve(values["durable-dir"]) : join(dataDir, "durable"),
  models: threadId => {
    const models = createModels();
    models.setProvider(poolProvider({ treeKey: `pi-durable:${threadId}`, agentDir, turns }));
    return models;
  },
  defaultModel: values.model ? { provider, modelId: modelId.join("/") } : { provider: "anthropic", modelId: "claude-opus-5-5" },
  defaultThinkingLevel: "high",
  defaultCwd: values.cwd ? resolve(values.cwd) : homedir(),
  settings: threadId => durableSettings(`pi-durable:${threadId}`),
  inputSettled: (threadId, session, runContinues) => turns.release({ root: `pi-durable:${threadId}`, session }, runContinues),
  turns: {
    ownerTurn: (threadId, session) => turns.ownerTurn({ root: `pi-durable:${threadId}`, session }),
    ticket: (threadId, session) => turns.ticket({ root: `pi-durable:${threadId}`, session }),
  },
  // Every thread's system prompt is a Prime chat's, built from this agent dir's AGENTS.md, skills, harness and the chat's ledger.
  prompt: { agentDir, tools: promptTools() },
  ...(chat ? { chat } : {}),
  ...(rlm ? { rlm } : {}),
  log: line => host.log(line),
}));

const host = new PiHost({
  durable,
  agentDir,
  sessionDir: values["session-dir"] ? resolve(values["session-dir"]) : undefined,
  dataDir: values["data-dir"] ? resolve(values["data-dir"]) : undefined,
  extensions,
  defaultCwd: values.cwd ? resolve(values.cwd) : undefined,
  defaultModel: values.model ? { provider, id: modelId.join("/") } : undefined,
  idleUnloadMs: values["idle-unload-min"] ? Number(values["idle-unload-min"]) * 60_000 : 30 * 60_000,
  scratchChatMark: values["scratch-chat"] === true,
});
installGuard(host);
const server = await listen(host, socketPath, { scratchChatMark: values["scratch-chat"] === true });
await durable?.threads.start().catch(error => host.log(`durable recovery failed: ${error instanceof Error ? error.stack : String(error)}`));
void host.warmProviders().then(rows => host.log(`provider modules loaded: ${rows.map(row => `${row.api} ${row.ms} ms${row.error ? ` (${row.error})` : ""}`).join(", ")}`));
host.log(`listening on ${socketPath} (pid ${process.pid}, agent dir ${agentDir}, ${extensions.length} extensions)`);
await host.recoverInboxes().catch(error => host.log(`inbox recovery failed: ${error instanceof Error ? error.message : String(error)}`));

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  host.log(`${signal}: disposing ${host.sessions.size} sessions`);
  await host.shutdown();
  server.close();
  try { unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
