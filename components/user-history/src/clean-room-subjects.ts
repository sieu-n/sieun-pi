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
