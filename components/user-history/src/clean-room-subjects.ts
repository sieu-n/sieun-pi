import { createHash } from "node:crypto";
import { join } from "node:path";
import { CLEAN_ROOM_CHATS_FILE } from "./chat-corrections.ts";
import { jobRegistry } from "./chat-sources.ts";
import { IdIndex } from "./id-index.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

/*
 * No agent message crosses the wall of a running clean-room trial: the test chat with its own sessions on one side, every other session but
 * the trial's runners on the other. On 10-25 at 00:46:07 KST the AI harness developer environment VP sent its release notice for sieun-pi
 * 9cc887bc to "root disk readings", a running test chat, and the verdict quoted it as someone stepping in, so the run was void. The fix then
 * took such a message to the trial owner filed in clean-room-subjects.json, but on 10-26 that file held no entry for the test chat
 * "test file counts 4" (01a177e7), so from 12:16 to 12:17Z three messages of the AI harness chat reached it and voided its trial. The trial
 * had asked first: its check-in job at 12:15:20Z and the chat at 12:16:45Z and 12:17:19Z asked the AI harness chat for code changes. So the
 * wall reads clean-room-chats.json, which setup always writes, refuses a message in either direction, and names where findings go instead.
 */

/**
 * The sessions that run clean-room trials, which reach a test chat and which its sessions reach: the realtime layer thread on the Mac and
 * chat-2572, which collects trial findings.
 */
export const TRIAL_RUNNERS: ReadonlyMap<string, string> = new Map([["01a0fd18-88e0-7168-8e3b-b0bc53da3610", "realtime layer"],
  ["01a162bc-47b4-770b-a9fc-19c3a742e730", "chat-2572"]]);
/** Where a sender outside a trial sends its findings about a test chat. */
export const FINDINGS_CHAT = "01a162bc-47b4-770b-a9fc-19c3a742e730";

export const CLEAN_ROOM_SUBJECTS_FILE = "clean-room-subjects.json";

/** A subject chat: the session that runs its trial, the run folder, the chat's name and when setup filed it. */
export interface Subject { owner: string; run: string; name: string; at: number }
interface Subjects { subjects: Record<string, Subject> }

const isSubject = (value: unknown): value is Subject => typeof value === "object" && value !== null &&
  ["owner", "run", "name"].every(key => typeof (value as Record<string, unknown>)[key] === "string") && typeof (value as Record<string, unknown>).at === "number";

const file = (dataDir: string): JsonFile<Subjects> => ({ path: join(dataDir, CLEAN_ROOM_SUBJECTS_FILE), label: "Clean-room subject index",
  initial: () => ({ subjects: {} }), parse(value: unknown): Subjects {
    const subjects = typeof value === "object" && value !== null && "subjects" in value && typeof value.subjects === "object" && value.subjects !== null ? value.subjects : {};
    return { subjects: Object.fromEntries(Object.entries(subjects).filter((entry): entry is [string, Subject] => isSubject(entry[1]))) };
  } });

export async function fileSubjects(dataDir: string, subjects: Readonly<Record<string, Subject>>): Promise<void> {
  await transactJsonFile(file(dataDir), state => { Object.assign(state.subjects, subjects); });
}

export async function forgetSubjects(dataDir: string, ids: readonly string[]): Promise<void> {
  await transactJsonFile(file(dataDir), state => { for (const id of ids) delete state.subjects[id]; });
}

export async function readSubjects(dataDir: string): Promise<Record<string, Subject>> {
  return (await snapshotJsonFile(file(dataDir))).subjects;
}

/**
 * The links of the sessions a chat itself started (`chatAgents`): its subagents and the roots it created. An agents list also shows link
 * "message" for any thread that only exchanged messages with the chat, such as the VP above, so being listed proves nothing.
 */
const OWN_LINKS: ReadonlySet<string> = new Set(["subagent", "root"]);

/**
 * The session ids of a chat's own participants: its duty jobs (its check-in jobs among them), from its duty runs, and every agent listed with
 * an own link. Only session ids count, never a name: a name can be on a different session.
 */
export function ownSessions(agents: readonly { sessionId?: string; link?: string }[], dutyJobs: readonly string[]): Set<string> {
  return new Set([...dutyJobs, ...agents.flatMap(agent => agent.sessionId && OWN_LINKS.has(agent.link ?? "") ? [agent.sessionId] : [])]);
}

/** What the wall reads from the chat service. */
export interface TrialSources {
  /** The running test chats: clean-room-chats.json less the archived ones, since teardown archives each test chat and its trial is then over. */
  trials(): Promise<readonly string[]>;
  subjects(): Promise<Record<string, Subject>>;
  /** The chat chat-jobs.json files a session under, such as a root job, a resumed job or a fixture; undefined for any other session. */
  chatOf(session: string): Promise<string | undefined>;
  /** The test chat's agents (`SessionRow.agents`) and the session ids of its duty jobs. */
  participants(id: string): Promise<{ agents: readonly { sessionId?: string; link?: string }[]; dutyJobs: readonly string[] }>;
}

/**
 * The running trial whose tree holds one of `sessions`: the test chat itself, a job chat-jobs.json files under it, or one of its own sessions
 * (`ownSessions`); undefined when none does.
 */
export async function trialOf(sources: TrialSources, sessions: readonly string[]): Promise<string | undefined> {
  const trials = await sources.trials();
  if (!trials.length || !sessions.length) return undefined;
  for (const session of sessions) {
    if (trials.includes(session)) return session;
    const chat = await sources.chatOf(session);
    if (chat && trials.includes(chat)) return chat;
  }
  for (const trial of trials) {
    const { agents, dutyJobs } = await sources.participants(trial);
    const own = ownSessions(agents, dutyJobs);
    if (sessions.some(session => own.has(session))) return trial;
  }
  return undefined;
}

/** An agent message to judge: the sender and the target, each with the root of its tree when it is a subagent's. */
export interface Crossing { from: string; fromRoot?: string; fromName?: string; to: string; toRoot?: string }

/** Whether a message may go, with the trial it touches; a refused one carries the line its sender reads. */
export type Verdict = { go: true; trial?: string } | { go: false; trial: string; reason: string };

const ids = (...values: (string | undefined)[]): string[] => [...new Set(values.filter((value): value is string => !!value))];

/**
 * The wall of a running trial. A message into a trial's tree goes only from that tree or from one of its runners (`TRIAL_RUNNERS` and the
 * trial owner its subject entry files); a message out of a trial's tree goes only to that tree or to one of its runners.
 */
export async function judgeCrossing(sources: TrialSources, message: Crossing): Promise<Verdict> {
  const senders = ids(message.from, message.fromRoot);
  const targets = ids(message.to, message.toRoot);
  const [fromTrial, toTrial] = await Promise.all([trialOf(sources, senders), trialOf(sources, targets)]);
  if (fromTrial === toTrial) return fromTrial ? { go: true, trial: fromTrial } : { go: true };
  const runs = async (trial: string, sessions: readonly string[]) => {
    const runners = new Set([...TRIAL_RUNNERS.keys(), ...ids((await sources.subjects())[trial]?.owner)]);
    return sessions.some(session => runners.has(session));
  };
  if (toTrial && !await runs(toTrial, senders)) {
    return { go: false, trial: toTrial, reason: `agent_message refused: ${message.to} is ${message.to === toTrial ? "" : `in the tree of `}the clean-room trial chat ${toTrial}, ` +
      `and a message from outside the trial voids it. Send your findings to chat-2572 (${FINDINGS_CHAT}) instead.` };
  }
  if (fromTrial && !await runs(fromTrial, targets)) {
    return { go: false, trial: fromTrial, reason: `agent_message refused: a clean-room trial starts no outside work, so this session of trial chat ${fromTrial} ` +
      `sends nothing to ${message.to}, which is outside the trial.` };
  }
  return { go: true, trial: (toTrial ?? fromTrial)! };
}

/** `TrialSources` from a chat service's files: its clean-room and archived chats, the subject index and job registry in `dataDir`, its catalog rows and its duty runs. */
export function trialSources(dataDir: string, read: { archived(): Promise<ReadonlySet<string>>; rows(): Promise<readonly { id: string; agents?: readonly { sessionId?: string; link?: string }[] }[]>;
  runs?(id: string): Promise<readonly { job?: { id: string } }[]> }): TrialSources {
  const chats = new IdIndex(join(dataDir, CLEAN_ROOM_CHATS_FILE), "Clean-room chat index");
  const jobs = jobRegistry(join(dataDir, "chat-jobs.json"));
  return {
    trials: async () => {
      const listed = await chats.ids().catch(() => []);
      if (!listed.length) return [];
      const archived = await read.archived();
      return listed.filter(id => !archived.has(id));
    },
    subjects: () => readSubjects(dataDir),
    chatOf: session => jobs.chatIdOf(session).catch(() => undefined),
    participants: async id => ({ agents: (await read.rows()).find(row => row.id === id)?.agents ?? [],
      dutyJobs: (await read.runs?.(id) ?? []).flatMap(run => run.job ? [run.job.id] : []) }),
  };
}

/** A delivery id for a message that has no outbox entry: the hash of its text. */
export const messageId = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;

/**
 * One receipt, the service.log line a path writes per message (a sibling, cross-host or queued send only when it touches a running trial), so
 * a trial audit tells senders and targets apart by session id: a job name alone named two jobs on 10-24. `to` is the target session; `refused` is set for a message the wall stopped.
 */
export interface Delivery { path: "sibling send" | "cross-host send" | "queued send" | "d9 push" | "job-steer"; from?: string; fromName?: string; fromChat?: string; to: string; id: string; refused?: string }

export function deliveryLine(delivery: Delivery): string {
  const from = `${delivery.from ?? "an unnamed caller"}${delivery.fromName ? ` (${delivery.fromName})` : ""}`;
  return `${delivery.refused ? "refused" : "delivery"} ${delivery.path}: from session ${from} of chat ${delivery.fromChat ?? "unknown"} to session ${delivery.to} as ${delivery.id}` +
    (delivery.refused ? `, clean-room trial ${delivery.refused}` : "");
}

/** The source of a d9 push or another duty's notice: the chat whose duty sent it. */
export interface TellSource { chat: string; duty: string }

/**
 * `DutyHost.tell`: a duty's notice to a chat, or to that chat's root job `session` when the tell names one, through `judgeCrossing`. A notice
 * the wall refuses is not sent and answers false. Writes one receipt line per notice.
 */
export function routedTell(sources: TrialSources, send: { notice(chat: string, text: string): Promise<void>; job(session: string, text: string): Promise<void> },
  log: (line: string) => void): (chat: string, text: string, from: TellSource, session?: string) => Promise<boolean> {
  return async (chat, text, from, session) => {
    const fromName = `duty ${from.duty}`;
    const verdict = await judgeCrossing(sources, { from: from.chat, fromName, to: session ?? chat, toRoot: chat });
    if (verdict.go) await (session ? send.job(session, text) : send.notice(chat, text));
    log(deliveryLine({ path: "d9 push", from: from.chat, fromName, fromChat: from.chat, to: session ?? chat, id: messageId(text), ...verdict.go ? {} : { refused: verdict.trial } }));
    return verdict.go;
  };
}

/** A job-steer the wall refused, with the line its caller reads. */
export interface RefusedSteer { refused: string }

/**
 * `POST api/threads/<chat>/job-steer` through `judgeCrossing`: the caller names its session with `X-Chat-Agent-Session` and its tree's root with
 * `X-Chat-Agent-Root`; an unnamed caller is outside every trial. Writes one receipt line per steer.
 */
export async function routedSteer<T>(sources: TrialSources, steer: { caller?: string; callerRoot?: string; callerChat?: string; chat: string; job: string; message: string },
  send: { steer(): Promise<T> }, log: (line: string) => void): Promise<T | RefusedSteer> {
  const verdict = await judgeCrossing(sources, { from: steer.caller ?? "", ...steer.callerRoot ? { fromRoot: steer.callerRoot } : {}, to: steer.chat });
  const from = { ...steer.caller ? { from: steer.caller } : {}, ...steer.callerChat ? { fromChat: steer.callerChat } : {} };
  if (!verdict.go) {
    log(deliveryLine({ path: "job-steer", ...from, fromName: `steering job ${steer.job} of chat ${steer.chat}`, to: steer.chat, id: messageId(steer.message), refused: verdict.trial }));
    return { refused: verdict.reason };
  }
  const answer: unknown = await send.steer();
  if (typeof answer === "object" && answer !== null && "session" in answer && typeof answer.session === "string") {
    log(deliveryLine({ path: "job-steer", ...from, fromName: `steering job ${steer.job} of chat ${steer.chat}`, to: answer.session, id: messageId(steer.message) }));
  }
  return answer as T;
}

/**
 * The check of a sender's kernel before an agent_message.send (`POST api/agent/route`, message-limit-check.py) and of the service paths that
 * carry one (`api/agent/message`, `api/agent/queue`): the verdict, with one receipt line when the message touches a trial.
 */
export async function routedSend(sources: TrialSources, message: Crossing & { text: string; path: Delivery["path"] }, chatOf: (session: string) => Promise<string | undefined>,
  log: (line: string) => void): Promise<Verdict> {
  const verdict = await judgeCrossing(sources, message);
  if (!verdict.trial) return verdict;
  const fromChat = await chatOf(message.fromRoot ?? message.from);
  log(deliveryLine({ path: message.path, from: message.from, ...message.fromName ? { fromName: message.fromName } : {}, ...fromChat ? { fromChat } : {}, to: message.to,
    id: messageId(message.text), ...verdict.go ? {} : { refused: verdict.trial } }));
  return verdict;
}
