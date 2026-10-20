/**
 * A clean-room create whose outcome setup knows before it goes on. Relative-duty run 20261019-1633 hit three faults in a row: the 15:49Z
 * create of "summary freshness" was refused after 58.2 s ("Daemon shutdown admission cancelled worker recovery") and still made session
 * 01a154da 20 s in; the setups at 16:04Z and 16:31Z then collided with that name; and the 16:33Z create's fetch gave up at 180 s while the
 * server went on, so the daemon answered after 134.9 s and the first message landed at 16:36:45Z, 16 s before a rerun with --chat built the
 * project folder again. A refusal or a timeout is therefore no proof that no chat exists.
 *
 * The record of each create goes into the run folder before its POST. A POST with no answer is sent again with the same request id, which the
 * server joins to the create it still runs or answers from the one it finished. An answered error settles that request, so setup looks for a
 * session the request made under any name it tried in the run's folder, adopts one the server registered, archives one it left unregistered,
 * and tries again with a new request id and, when the name is held, the next free name.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DUTY_LOOKUP_WAITS_MS } from "../../src/chat-duty-job.ts";
import { DAEMON_WORKER_START_MS } from "../../src/daemon-worker-start.ts";

/** One create of the run, kept in `<run>/setup.pending.json` from before its first POST until setup ends. */
export interface CreateRecord {
  kind: "chat" | "thread";
  /** The name the next POST asks for; `names` holds every name the run tried, this one last. */
  name: string;
  names: string[];
  cwd: string;
  message: string;
  requestId: string;
  /** When the run first asked for this create; a session made before it is not the run's. */
  since: number;
  /** The request id of the first message when setup sends it to an adopted session, so a rerun sends the same one. */
  deliverRequestId?: string;
  id?: string;
  adopted?: boolean;
}

/**
 * The body of one `POST api/threads` for `record`, with the model every trial runs on. `nameBeforeFirst` names a fixture before its first
 * message, so its first cells already find the trial harness store setup filed under that name (src/trial-harness.ts).
 */
export const createBody = (record: CreateRecord, model: Record<string, string>): Record<string, unknown> =>
  ({ requestId: record.requestId, cwd: record.cwd, message: record.message, name: record.name, kind: record.kind, nameBeforeFirst: true, ...model });

/** What one `POST api/threads` told setup. */
export type CreateAnswer =
  | { kind: "made"; id: string }
  /** The server answered with its error, so its create for this request id is settled. */
  | { kind: "refused"; status: number; error: string }
  /** No answer from the server: a timeout, a dropped connection or a gateway status. Its create may still finish. */
  | { kind: "unknown"; error: string };

/** A session found on disk under one of a record's names, in its folder, made since the record's start. */
export interface FoundSession { id: string; name: string; registered: boolean; delivered: boolean }

export interface CreateIo {
  post(record: CreateRecord): Promise<CreateAnswer>;
  find(record: CreateRecord): Promise<FoundSession | undefined>;
  archive(id: string): Promise<void>;
  deliver(id: string, message: string, requestId: string): Promise<void>;
  save(record: CreateRecord): void;
  log(line: string): void;
  newRequestId(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The daemon's refusal of a root name any session ever had, archived ones included (src/chat-duty-job.ts). */
export const NAME_TAKEN = /name .* is unavailable: an agent of that name already exists/i;

/** The name after `name` in the run's sequence: "stale summary check", then "stale summary check 2", "stale summary check 3". */
export const nextName = (name: string, names: readonly string[]): string => {
  const base = names[0] ?? name;
  for (let index = 2; ; index++) if (!names.includes(`${base} ${index}`)) return `${base} ${index}`;
};

export interface CreateWaits {
  /** The looks for a session after an answered error: a refused create made one 20 s in on 10-19 15:49Z. */
  lookupWaitsMs: readonly number[];
  /** How long setup keeps asking: the daemon's longest create took 1,388 s (src/daemon-worker-start.ts). */
  boundMs: number;
  /** The pause before a POST with no answer goes again, the step of throughRestart in src/chat-host.ts. */
  stepMs: number;
}
export const CREATE_WAITS: CreateWaits = { lookupWaitsMs: DUTY_LOOKUP_WAITS_MS, boundMs: DAEMON_WORKER_START_MS, stepMs: 2_000 };

/** The session `record` stands for once its outcome is known: made by a POST, or adopted from disk with its first message delivered. */
export async function createOrAdopt(record: CreateRecord, io: CreateIo, waits: CreateWaits = CREATE_WAITS): Promise<{ id: string; adopted: boolean }> {
  if (record.id) return { id: record.id, adopted: record.adopted === true };
  const deadline = io.now() + waits.boundMs;
  const look = async (): Promise<FoundSession | undefined> => {
    for (const wait of waits.lookupWaitsMs) {
      if (wait > 0) await io.sleep(wait);
      const found = await io.find(record);
      if (found) return found;
    }
    return undefined;
  };
  const done = (id: string, adopted: boolean) => { record.id = id; record.adopted = adopted; io.save(record); return { id, adopted }; };
  io.save(record);
  for (;;) {
    const answer = await io.post(record);
    if (answer.kind === "made") return done(answer.id, false);
    if (io.now() > deadline) throw new Error(`create "${record.name}" has no known outcome after ${Math.round(waits.boundMs / 1000)} s: ${answer.error}`);
    if (answer.kind === "unknown") {
      io.log(`create "${record.name}" (request ${record.requestId}) got no answer (${answer.error}); asking again with the same request id`);
      await io.sleep(waits.stepMs);
      continue;
    }
    if (answer.status < 500) throw new Error(`create "${record.name}" refused: ${answer.status} ${answer.error}`);
    const found = await look();
    if (found?.registered) {
      record.name = found.name;
      if (!found.delivered) {
        record.deliverRequestId ??= io.newRequestId();
        io.save(record);
        await io.deliver(found.id, record.message, record.deliverRequestId);
        io.log(`create "${found.name}" was refused (${answer.error}) after the server made it; adopted ${found.id} and sent its first message (request ${record.deliverRequestId})`);
      } else io.log(`create "${found.name}" was refused (${answer.error}) after the server made it and sent its first message; adopted ${found.id}`);
      return done(found.id, true);
    }
    if (found) {
      await io.archive(found.id);
      io.log(`create "${found.name}" was refused (${answer.error}) but made session ${found.id}, which no chat list holds; archived it`);
    }
    if (found || NAME_TAKEN.test(answer.error)) {
      const name = nextName(record.name, record.names);
      io.log(`the name "${record.name}" is held${found ? " by that session" : " by another session"}; trying "${name}"`);
      record.name = name;
      record.names.push(name);
    } else io.log(`create "${record.name}" was refused (${answer.error}) and made no session; asking again`);
    record.requestId = io.newRequestId();
    io.save(record);
  }
}

/** What a root session file says about itself: its id, start, folder, first name and whether a user message reached it. */
export interface SessionFacts { id: string; at: number; cwd: string; name: string; delivered: boolean }
export function sessionFacts(file: string): SessionFacts | undefined {
  type Entry = { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown; name?: unknown; message?: { role?: unknown } };
  let header: Entry | undefined;
  let name = "";
  let delivered = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; } catch { continue; }
    if (!header) { if (entry.type !== "session") return undefined; header = entry; continue; }
    if (entry.type === "session_info" && !name && typeof entry.name === "string") name = entry.name.trim();
    if (entry.type === "message" && entry.message?.role === "user") delivered = true;
  }
  if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
  return { id: header.id, at: Date.parse(String(header.timestamp ?? "")) || 0, cwd: header.cwd, name, delivered };
}

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

/** The root session in `sessionsDir` made since `record.since` in its folder under one of its names; `chats` decides a chat's registration. */
export function findSession(sessionsDir: string, record: CreateRecord, chats: ReadonlySet<string>): FoundSession | undefined {
  if (!existsSync(sessionsDir)) return undefined;
  const cwd = real(record.cwd);
  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(sessionsDir, file);
    if (statSync(path).mtimeMs < record.since) continue;
    const facts = sessionFacts(path);
    if (!facts || facts.at < record.since || !record.names.includes(facts.name) || real(facts.cwd) !== cwd) continue;
    return { id: facts.id, name: facts.name, registered: record.kind === "thread" || chats.has(facts.id), delivered: facts.delivered };
  }
  return undefined;
}

/**
 * The project folder of a chat that `setup --chat` adopts: the folder its session runs in. Adoption never builds it, so a chat whose task has
 * already arrived keeps the files it was given. A run folder that names another project, or a folder that is gone, stops setup.
 */
export function adoptedWorkspace(chat: SessionFacts | undefined, pendingSandbox: string | undefined): string {
  if (!chat) throw new Error("setup --chat: the chat has no session file to adopt");
  if (pendingSandbox !== undefined && real(pendingSandbox) !== real(chat.cwd)) throw new Error(`setup --chat: the chat ${chat.id} runs in ${chat.cwd}, but this run's project is ${pendingSandbox}`);
  if (!existsSync(chat.cwd)) {
    throw new Error(`setup --chat: the chat ${chat.id}'s folder ${chat.cwd} is gone${chat.delivered ? " and its first message has arrived" : ""}; ` +
      "adoption never builds a project again, so start a new run folder");
  }
  return chat.cwd;
}
