import { createHash } from "node:crypto";
import { join } from "node:path";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

/*
 * The clean-room subjects: each test chat clean-room.ts setup opened, with its trial owner, the session that ran setup. On 10-25 at 00:46:07 KST
 * the AI harness developer environment VP sent its release notice for sieun-pi 9cc887bc to "root disk readings", a running test chat, because
 * that chat's own check-in had told it about a finding. The verdict quoted the notice as someone stepping in and the run was void. So an agent
 * message from outside a subject's own sessions goes to its trial owner (`subjectRoute`), and the sender's receipt says so.
 */

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

/** Who gets an agent message sent to a session: the session itself, or the subject's trial owner with the message headed for it. */
export type Route = { to: "target" } | { to: "owner"; owner: string; text: string };

/** What `routeMessage` reads from the chat service. */
export interface RouteSources {
  subjects(): Promise<Record<string, Subject>>;
  /** Whether the chat is archived, which teardown does to every subject; an archived subject's trial is over. */
  archived(id: string): Promise<boolean>;
  /** The subject chat's agents (`SessionRow.agents`) and the session ids of its duty jobs. */
  participants(id: string): Promise<{ agents: readonly { sessionId?: string; link?: string }[]; dutyJobs: readonly string[] }>;
}

/**
 * Where an agent message from session `from` to session `to` goes. A message to an active subject from a session outside its own
 * participants (`ownSessions`) goes to its trial owner; every other message goes to its target. The subject itself and its own sessions
 * always reach it, and so do the owner's messages and the service's wakes, which come by other routes.
 */
export async function routeMessage(sources: RouteSources, message: { from: string; fromName?: string; to: string; text: string }): Promise<Route> {
  const subject = (await sources.subjects())[message.to];
  if (!subject || message.from === message.to || message.from === subject.owner || await sources.archived(message.to)) return { to: "target" };
  const { agents, dutyJobs } = await sources.participants(message.to);
  if (ownSessions(agents, dutyJobs).has(message.from)) return { to: "target" };
  const sender = message.fromName ? `${message.fromName} (${message.from})` : message.from;
  return { to: "owner", owner: subject.owner, text: `[clean-room: ${sender} sent this to "${subject.name}" (${message.to}), a test chat of your trial in ` +
    `${subject.run}. It is not one of that chat's own sessions, so the chat service brought it to you, the trial owner, and the chat did not get it]\n\n${message.text}` };
}

/** `RouteSources` from a chat service's files: the subject index in `dataDir`, its archived chats, its catalog rows and its duty runs. */
export function subjectSources(dataDir: string, read: { archived(): Promise<ReadonlySet<string>>; rows(): Promise<readonly { id: string; agents?: readonly { sessionId?: string; link?: string }[] }[]>;
  runs?(id: string): Promise<readonly { job?: { id: string } }[]> }): RouteSources {
  return { subjects: () => readSubjects(dataDir), archived: async id => (await read.archived()).has(id),
    participants: async id => ({ agents: (await read.rows()).find(row => row.id === id)?.agents ?? [],
      dutyJobs: (await read.runs?.(id) ?? []).flatMap(run => run.job ? [run.job.id] : []) }) };
}

/**
 * Sends a message through `target`, unless `routeMessage` takes it to the trial owner; then `owner` sends the headed text and answers its
 * delivery id (the agent outbox entry).
 */
export async function deliverRouted<T>(sources: RouteSources, message: Parameters<typeof routeMessage>[1],
  send: { target(): Promise<T>; owner(owner: string, text: string): Promise<string> }): Promise<{ to: "target"; sent: T } | { to: "owner"; owner: string; id: string }> {
  const route = await routeMessage(sources, message);
  return route.to === "owner" ? { to: "owner", owner: route.owner, id: await send.owner(route.owner, route.text) } : { to: "target", sent: await send.target() };
}

/** A delivery id for a message that has no outbox entry: the hash of its text. */
export const messageId = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;

/**
 * One delivery receipt, the service.log line a path writes per message it delivers, so a trial audit tells senders and targets apart by session
 * id: a job name alone named two jobs on 10-24. `to` is the target session; `owner` is set when the message went to the trial owner instead.
 */
export interface Delivery { path: "sibling send" | "d9 push" | "job-steer"; from?: string; fromName?: string; fromChat?: string; to: string; id: string; owner?: string }

export function deliveryLine(delivery: Delivery): string {
  const from = `${delivery.from ?? "an unnamed caller"}${delivery.fromName ? ` (${delivery.fromName})` : ""}`;
  return `delivery ${delivery.path}: from session ${from} of chat ${delivery.fromChat ?? "unknown"} to session ${delivery.to} as ${delivery.id}` +
    (delivery.owner ? `, taken to the trial owner ${delivery.owner}` : "");
}

/** The source of a d9 push or another duty's notice: the chat whose duty sent it. */
export interface TellSource { chat: string; duty: string }

/**
 * `DutyHost.tell`: a duty's notice to a chat, through `routeMessage`, with a receipt line per notice. With `session` it goes to that root job
 * of the chat (`job`), routed as a message to the chat, since d9 sends a chat that cannot take a turn nothing and its job's step would have no
 * one to wake it: frontend bro's job "5180 creators cold load" ended idle at 10:13Z on 10-26 with p330 open while every turn of the chat failed on a 429.
 */
export function routedTell(sources: RouteSources, send: { notice(chat: string, text: string): Promise<void>; job(session: string, text: string): Promise<void>;
  owner(owner: string, text: string): Promise<string> }, log: (line: string) => void): (chat: string, text: string, from: TellSource, session?: string) => Promise<void> {
  return async (chat, text, from, session) => {
    const fromName = `duty ${from.duty}`;
    const target = session ? () => send.job(session, text) : () => send.notice(chat, text);
    const sent = await deliverRouted(sources, { from: from.chat, fromName, to: chat, text }, { target, owner: send.owner });
    log(deliveryLine({ path: "d9 push", from: from.chat, fromName, fromChat: from.chat, to: sent.to === "owner" ? chat : session ?? chat,
      ...sent.to === "owner" ? { id: sent.id, owner: sent.owner } : { id: messageId(text) } }));
  };
}

/** A job-steer the trial owner got instead of the test chat's job. */
export interface OwnerSteer { act: "trial owner"; session: string; id: string }

/**
 * `POST api/threads/<chat>/job-steer` through `routeMessage`: a steer of a test chat's job from a caller that is not one of the chat's own
 * sessions (the header `X-Chat-Agent-Session`, absent from an unnamed caller) goes to the trial owner. Writes one receipt line per steer.
 */
export async function routedSteer<T>(sources: RouteSources, steer: { caller?: string; callerChat?: string; chat: string; job: string; message: string },
  send: { steer(): Promise<T>; owner(owner: string, text: string): Promise<string> }, log: (line: string) => void): Promise<T | OwnerSteer> {
  const sent = await deliverRouted(sources, { from: steer.caller ?? "", ...steer.caller ? {} : { fromName: "an unnamed caller" }, to: steer.chat,
    text: `[job-steer for its job "${steer.job}"]\n\n${steer.message}` }, { target: send.steer, owner: send.owner });
  const from = { ...steer.caller ? { from: steer.caller } : {}, ...steer.callerChat ? { fromChat: steer.callerChat } : {} };
  if (sent.to === "owner") {
    log(deliveryLine({ path: "job-steer", ...from, to: steer.chat, id: sent.id, owner: sent.owner }));
    return { act: "trial owner", session: sent.owner, id: sent.id };
  }
  const answer: unknown = sent.sent;
  if (typeof answer === "object" && answer !== null && "session" in answer && typeof answer.session === "string") {
    log(deliveryLine({ path: "job-steer", ...from, fromName: `steering job ${steer.job} of chat ${steer.chat}`, to: answer.session, id: messageId(steer.message) }));
  }
  return sent.sent;
}

/**
 * `POST api/agent/route`: a sibling send to a clean-room test chat (message-limit-check.py). From outside the chat's own sessions `owner` sends
 * it to the trial owner; otherwise the sender's kernel sends it itself. Writes one receipt line either way and answers the kernel.
 */
export async function routedSibling(sources: RouteSources, message: Parameters<typeof routeMessage>[1], send: { owner(owner: string, text: string): Promise<string>; chatOf(session: string): Promise<string | undefined> },
  log: (line: string) => void): Promise<{ redirected: true; owner: string; id: string } | { redirected: false; id: string }> {
  const route = await routeMessage(sources, message);
  const id = route.to === "owner" ? await send.owner(route.owner, route.text) : messageId(message.text);
  const fromChat = await send.chatOf(message.from);
  log(deliveryLine({ path: "sibling send", from: message.from, ...message.fromName ? { fromName: message.fromName } : {}, ...fromChat ? { fromChat } : {}, to: message.to, id,
    ...route.to === "owner" ? { owner: route.owner } : {} }));
  return route.to === "owner" ? { redirected: true, owner: route.owner, id } : { redirected: false, id };
}
