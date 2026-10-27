/**
 * pi-host CLI:
 *
 *   node --import tsx host/src/main.ts --socket <path> --agent-dir <dir> [--session-dir <dir>] [--data-dir <dir>] [--extension <path>]... [--cwd <dir>]
 *     [--model <provider/id>] [--idle-unload-min <n>] [--scratch-chat] [--extensions-file <path>] [--no-default-extensions]
 *
 * Every session loads the extensions listed in `host/extensions.json` (paths relative to that file), then each `--extension`, which repeats.
 * `--extensions-file` names another list, and `--no-default-extensions` skips the list. `--scratch-chat` marks the hello so a scratch chat serve passes writes. SIGTERM and
 * SIGINT dispose every session, release every lease, remove the socket and exit 0.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
/** `{ "extensions": ["../agent-bus/index.ts", ...] }`, each path relative to the list file. */
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
