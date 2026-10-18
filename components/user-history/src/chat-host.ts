import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { jobRegistry, type JobRegistry } from "./chat-sources.ts";
import { HOSTS_FILE, loadHosts, roleUrl, selfHost } from "./hosts.ts";

/**
 * The chat service a session's extension talks to: the one on this box (its `instance.json`), or the chat host of hosts.json when the chat
 * role is on another box. `remote` is true for the second, and then every chat file (boards, check-in settings, the job registry, the
 * corrections ledger) lives there: this box's `browser-chat` folder is a stale copy that nothing serves since the chat moved (us-metal02,
 * 10-18 04:19Z), so a Mac chat's chat_board write that fell back to it split the board.
 */
export type ChatService = { base: string; token: string; origin: string; remote: boolean };

const ACCESS_FILE = join(homedir(), ".config/sieun-pi/chat-access.json");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The chat host of hosts.json when it is another box, with the capability and token from ~/.config/sieun-pi/chat-access.json; else null. */
export async function remoteChatService(hostsFile = process.env.SIEUN_PI_HOSTS ?? HOSTS_FILE, accessFile = ACCESS_FILE): Promise<ChatService | null> {
  let registry;
  try { registry = await loadHosts(hostsFile); } catch { return null; }
  const holder = registry.hosts.find(host => host.roles.chat);
  const url = roleUrl(registry, "chat");
  if (!holder || !url || holder.name === selfHost(registry)?.name) return null;
  const access = JSON.parse(await readFile(accessFile, "utf8")) as unknown;
  if (!isRecord(access) || typeof access.capability !== "string" || typeof access.csrfToken !== "string") throw new Error(`${accessFile}: needs capability and csrfToken`);
  const origin = new URL(url).origin;
  return { base: `${origin}/${access.capability}/`, token: access.csrfToken, origin, remote: true };
}

/**
 * The chat service for `dataDir`: the chat host of hosts.json when it is another box, else this box's own. Its address comes from
 * configuration.json (port and capability, the same URL the service publishes in instance.json), because the service is away from
 * instance.json while it restarts and job-steer.ts failed with ENOENT on us-metal02 then (10-18). instance.json is read only for a
 * configuration without a port. Null when neither is set up.
 */
export async function chatService(dataDir: string): Promise<ChatService | null> {
  const remote = await remoteChatService();
  if (remote) return remote;
  try {
    const config = JSON.parse(await readFile(join(dataDir, "configuration.json"), "utf8")) as { csrfToken?: unknown; port?: unknown; capability?: unknown };
    if (typeof config.csrfToken !== "string") return null;
    let base: string;
    if (typeof config.port === "number" && typeof config.capability === "string") base = `http://127.0.0.1:${config.port}/${config.capability}/`;
    else {
      const instance = JSON.parse(await readFile(join(dataDir, "instance.json"), "utf8")) as { url?: unknown };
      if (typeof instance.url !== "string") return null;
      base = instance.url;
    }
    return { base, token: config.csrfToken, origin: new URL(base).origin, remote: false };
  } catch { return null; }
}

/**
 * How long a call waits through a chat service restart: the cross-host routes were down or incomplete for about 23 s after a restart on
 * us-metal02 (10-18: stop 05:14:32Z, start 05:14:37Z, Mac listed 05:14:55Z), and releases restart the service every few minutes.
 */
export const RESTART_WAIT_MS = 60_000;
const RESTARTING = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Chat service answered 50[234]/;
const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : String(error.cause ?? "")}` : String(error);

/** `attempt`'s answer, run again every `stepMs` while it fails the way a restarting chat service fails, for up to `waitMs`. */
export async function throughRestart<T>(attempt: () => Promise<T>, waitMs = RESTART_WAIT_MS, stepMs = 2_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return await attempt(); }
    catch (error) {
      if (!RESTARTING.test(errorText(error)) || Date.now() + stepMs > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, stepMs));
    }
  }
}

/** One call to the chat service: a GET, or a POST of `body` with the write token. Null for a 404; other answers throw with the service's error. */
export async function serviceCall<T>(service: ChatService, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(service.base + path, {
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Token": service.token, Origin: service.origin }, body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) {
    let error = text;
    try { error = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
    throw new Error(`Chat service answered ${response.status}: ${error.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

type Jobs = { jobs: Record<string, { chat: string; at: number; chatId?: string }> };

/** The chat job registry where it lives: the remote chat host's (api/agent/jobs), else `<dataDir>/chat-jobs.json`. */
export function hostJobRegistry(dataDir: string): JobRegistry {
  const local = jobRegistry(join(dataDir, "chat-jobs.json"));
  const read = async (service: ChatService): Promise<Jobs> => await serviceCall<Jobs>(service, "api/agent/jobs") ?? { jobs: {} };
  const remote = () => remoteChatService();
  return {
    async add(names, chat, chatId) { const service = await remote(); if (!service) return local.add(names, chat, chatId); await serviceCall(service, "api/agent/jobs", { op: "add", names, chat, ...(chatId ? { chatId } : {}) }); },
    async chatOf(name) { const service = await remote(); return service ? (await read(service)).jobs[name]?.chat : local.chatOf(name); },
    async chatIdOf(name) { const service = await remote(); return service ? (await read(service)).jobs[name]?.chatId : local.chatIdOf(name); },
    async rootsOf(chat) {
      const service = await remote();
      if (!service) return local.rootsOf(chat);
      return Object.entries((await read(service)).jobs).filter(([, entry]) => chat.includes(entry.chat) || (entry.chatId !== undefined && chat.includes(entry.chatId))).map(([name]) => name);
    },
    async remove(names) { const service = await remote(); if (!service) return local.remove(names); await serviceCall(service, "api/agent/jobs", { op: "remove", names }); },
  };
}
