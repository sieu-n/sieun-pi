/**
 * pi-host CLI:
 *
 *   node --import tsx host/src/main.ts --socket <path> --agent-dir <dir> [--session-dir <dir>] [--data-dir <dir>] [--extension <path>]... [--cwd <dir>]
 *     [--model <provider/id>] [--idle-unload-min <n>] [--scratch-chat]
 *
 * `--extension` repeats and loads into every session. `--scratch-chat` marks the hello so a scratch chat serve passes writes. SIGTERM and
 * SIGINT dispose every session, release every lease, remove the socket and exit 0.
 */

import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
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
const [provider, ...modelId] = (values.model ?? "").split("/");

const extensions = (values.extension ?? []).map(path => resolve(path));
// pi-rlm children load the host's extensions plus the scheduler's, so a child's rlm_heartbeat jobs attach to this host's scheduler.
const { setChildLoaderOptions } = await import("../../rlm/src/children.ts");
setChildLoaderOptions(() => ({ additionalExtensionPaths: extensions, extensionFactories: [schedulerExtension] }));

const host = new PiHost({
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
host.log(`listening on ${socketPath} (pid ${process.pid}, agent dir ${agentDir})`);

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
