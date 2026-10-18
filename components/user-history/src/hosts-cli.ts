import { DaemonClient } from "prime-agent";
import { HostBridge, hostHealth, hostNamed, loadHosts, readHostFile, selfHost, type Host } from "./hosts.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const USAGE = `usage: sieun-pi hosts <command>

  list                                     each host in ~/.config/sieun-pi/hosts.json, its roles and its relay's health
  start <host> [--cwd <dir>] [--name <n>] [--model <provider/id>] [--thinking <level>] <prompt>
                                           starts a resident session on that host's daemon with the prompt as its first user message
  read <host> <path> [--from <bytes>]      prints a file from that host's sessions or session-artifacts
  transcript <host> <session id> [--from <bytes>]
                                           prints that session's messages, read through the relay
  daemon <host> list [--all 1]             prints that host's daemon list as {"sessions": [...]}, like prime-agent list --json
  daemon <host> send <session> <message>   sends the message to that session on that host's daemon and prints the daemon's answer
  bridge                                   keeps ~/.local/state/sieun-pi/hosts/<host>.sock open for every other host`;

function flags(argv: string[]): { rest: string[]; values: Map<string, string> } {
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      values.set(arg.slice(2), value);
    } else rest.push(arg);
  }
  return { rest, values };
}

/** A daemon client for `host`: the self host's own socket, any other host through a private bridge socket closed with the client. */
async function clientFor(host: Host, registry: Awaited<ReturnType<typeof loadHosts>>): Promise<{ client: DaemonClient; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "sieun-pi-hosts-"));
  const bridge = new HostBridge(registry, { dir });
  await bridge.start();
  const client = new DaemonClient(bridge.socketPath(host.name));
  await client.connect(10_000);
  await client.waitForHello(10_000);
  return { client, close: async () => { client.close(); await bridge.close(); await rm(dir, { recursive: true, force: true }); } };
}

type Summary = { sessionId?: string; activeSessionId?: string; sessionFile?: string; id?: string };

async function sessionFile(host: Host, registry: Awaited<ReturnType<typeof loadHosts>>, id: string): Promise<string> {
  if (id.startsWith("/")) return id;
  const { client, close } = await clientFor(host, registry);
  try {
    const response = await client.request({ type: "list", all: true } as Parameters<DaemonClient["request"]>[0], 60_000, { recoverable: false });
    if (!response.success) throw new Error(response.error);
    const data = response.data as { sessions?: Summary[] } | Summary[];
    const sessions = Array.isArray(data) ? data : data.sessions ?? [];
    const match = sessions.find(session => session.sessionId === id || session.activeSessionId === id || session.id === id || session.sessionId?.startsWith(id));
    if (!match?.sessionFile) throw new Error(`no session ${id} on ${host.name}`);
    return match.sessionFile;
  } finally { await close(); }
}

function messageText(entry: Record<string, unknown>): string | null {
  const message = entry.message as { role?: string; content?: unknown } | undefined;
  if (entry.type !== "message" || !message?.role) return null;
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  const text = parts.map(part => typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text)
    : part && typeof part === "object" && "type" in part ? `[${String((part as { type: unknown }).type)}]` : "").join(" ").replace(/\s+/g, " ").trim();
  return `${message.role}: ${text.slice(0, 400)}`;
}

export async function runHostsCommand(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") { process.stdout.write(`${USAGE}\n`); return; }
  const registry = await loadHosts();
  const { rest, values } = flags(args);
  if (command === "list") {
    const self = selfHost(registry);
    for (const host of registry.hosts) {
      const health = await hostHealth(host);
      const roles = Object.keys(host.roles).join(",") || "-";
      const state = health.ok ? `relay ok in ${health.ms} ms, daemon ${health.daemon}` : `relay unreachable: ${health.error}`;
      process.stdout.write(`${host.name}${host.name === self?.name ? " (this machine)" : ""}  ${host.address}:${host.relayPort}  roles ${roles}  ${state}\n`);
    }
  } else if (command === "start") {
    const [name, ...words] = rest;
    if (!name || !words.length) throw new Error(USAGE);
    const host = hostNamed(registry, name);
    const cwd = values.get("cwd") ?? (host.name === selfHost(registry)?.name ? homedir() : null);
    if (!cwd) throw new Error(`name the session's folder on ${host.name} with --cwd`);
    const { client, close } = await clientFor(host, registry);
    try {
      const model = values.get("model");
      const [provider, ...modelId] = model ? model.split("/") : [];
      const thinking = values.get("thinking");
      const created = await client.request({ type: "create", lifecycle: "resident", ...(values.has("name") ? { name: values.get("name")! } : {}),
        config: { cwd, ...(provider && modelId.length ? { provider, model: modelId.join("/") } : {}), ...(thinking ? { thinking } : {}) } } as Parameters<DaemonClient["request"]>[0],
        120_000, { recoverable: false });
      if (!created.success) throw new Error(created.error);
      const data = created.data as Summary;
      if (!data.activeSessionId) throw new Error(`${host.name} returned no session`);
      const sent = await client.request({ type: "prompt", activeSessionId: data.activeSessionId, message: words.join(" "), source: "interactive", queueIfBusy: true } as Parameters<DaemonClient["request"]>[0], 30_000, { recoverable: false });
      if (!sent.success) throw new Error(sent.error);
      process.stdout.write(`${JSON.stringify({ host: host.name, sessionId: data.sessionId, activeSessionId: data.activeSessionId, sessionFile: data.sessionFile })}\n`);
    } finally { await close(); }
  } else if (command === "read" || command === "transcript") {
    const [name, target] = rest;
    if (!name || !target) throw new Error(USAGE);
    const host = hostNamed(registry, name);
    const path = command === "read" ? target : await sessionFile(host, registry, target);
    const { bytes, size } = await readHostFile(host, path, { from: Number(values.get("from") ?? 0) });
    if (command === "read") { process.stdout.write(bytes); return; }
    process.stdout.write(`${host.name}:${path} (${size} bytes)\n`);
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const text = messageText(JSON.parse(line) as Record<string, unknown>); if (text) process.stdout.write(`${text}\n`); } catch { /* a partial last line */ }
    }
  } else if (command === "daemon") {
    // resume_paused.py drives another box's daemon through this: prime-agent's own CLI waits 3 s for the daemon's hello, which a relay tunnel
    // from us-metal02 to the Mac missed on every try at 05:10Z on 10-18.
    const [name, action, target, ...words] = rest;
    if (!name || (action !== "list" && !(action === "send" && target && words.length))) throw new Error(USAGE);
    const { client, close } = await clientFor(hostNamed(registry, name), registry);
    try {
      const command = action === "list" ? { type: "list", ...(values.get("all") ? { all: true } : {}) } : { type: "send_message", targetActiveSessionId: target, message: words.join(" ") };
      const response = await client.request(command as Parameters<DaemonClient["request"]>[0], 60_000, { recoverable: false });
      if (!response.success) throw new Error(response.error);
      const data = response.data as { sessions?: unknown } | unknown[];
      process.stdout.write(`${JSON.stringify(action === "list" ? { sessions: Array.isArray(data) ? data : (data as { sessions?: unknown }).sessions ?? [] } : data)}\n`);
    } finally { await close(); }
  } else if (command === "bridge") {
    const bridge = new HostBridge(registry, { log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
    await bridge.start();
    for (const host of registry.hosts) process.stderr.write(`${host.name}: ${bridge.socketPath(host.name)}\n`);
    await new Promise<void>(resolve => { for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve()); });
    await bridge.close();
  } else throw new Error(`unknown command ${command}\n${USAGE}`);
}
