import { childName, childWorking, stepOwner } from "./checkin-steps.ts";
import { createdSessions } from "./shared/created-sessions.ts";
import type { AgentLink, AgentState, ChatAgent, ChatBoard, ChildAgent, PlanItem, QueuePlace, SessionRow, ThreadMessage, TokenRate } from "./shared/types.ts";
import { treeWakes, type Wake, wakeWait } from "./wakes.ts";

/** A thread the chat exchanged agent messages with this long ago still counts as linked. */
export const CONTACT_WINDOW_MS = 24 * 60 * 60_000;
/** Words a derived display name keeps. */
const NAME_WORDS = 4;

/** A daemon session that is a direct subagent of the chat, as the catalog sees it; `first` is its first task text, for the display name. */
export interface SubagentSession {
  sessionId: string; childId?: string; name?: string; first?: string; running: boolean; failed: boolean; activity?: string; lastActivityAt?: string;
  /** Running subagents below it at any depth; absent at 0. */
  subagentsRunning?: number;
  /** Subagents below it at any depth that the daemon still lists, finished ones included; absent at 0. */
  subagentsTotal?: number;
}
/** A top-level session as the catalog projects it, plus its first task text. */
export interface AgentRow { row: SessionRow; first?: string }
/**
 * One agent message between the chat and another agent, from the chat's transcript. `who` is the other side as the transcript names it: a
 * session id (a sent message's receipt names the target), `child:<name>`, or a session name (a received message's header). `text` is the
 * first line of a received message, empty for a sent one.
 */
export interface Contact { who: string; at: number; direction: "sent" | "received"; text: string }

export interface AgentSources {
  /** The chat's own id and name: steps it owns and messages to itself are no agent. */
  self: { id: string; name: string };
  /** The hub's child snapshots for the chat (empty when the chat is not attached). */
  children: readonly ChildAgent[];
  /** The daemon's sessions under the chat. */
  childSessions: readonly SubagentSession[];
  board: ChatBoard | null;
  /** Session names the chat started with rlm.create_session, from the job registry. */
  roots: readonly string[];
  /** The chat's transcript: created-session handles and agent messages are read from it. */
  messages: readonly ThreadMessage[];
  /** Every top-level session, to resolve names and ids. */
  rows: readonly AgentRow[];
  now: number;
}

const RECEIPT = /'source': 'agent_message', 'target': \{[^}]*?'sessionId': '([^']+)'/g;
const messageText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap((part: unknown) => typeof part === "object" && part !== null && "text" in part ? [String((part as { text: unknown }).text)] : []).join("\n") : "";
const firstLine = (text: string): string => text.split("\n").map(line => line.trim()).find(Boolean) ?? "";

/**
 * The agent messages the chat exchanged since `since`: a received one is a custom agent_message whose header names the sender; a sent one is the
 * receipt `agent_message.send` printed in an ipython tool result, which names the target session.
 */
export function agentContacts(messages: readonly ThreadMessage[], since: number): Contact[] {
  const contacts: Contact[] = [];
  for (const message of messages) {
    if (message.timestamp < since) continue;
    if (message.role === "custom" && message.customType === "agent_message") {
      const text = messageText(message.content);
      const header = /^\s*\[agent-message from\s+([^\]]+)\]/.exec(text);
      if (!header) continue;
      contacts.push({ who: header[1]!.trim(), at: message.timestamp, direction: "received", text: firstLine(text.slice(header[0].length)) });
    } else if (message.role === "toolResult") {
      for (const part of message.content) {
        if (part.type !== "text") continue;
        for (const match of part.text.matchAll(RECEIPT)) contacts.push({ who: match[1]!, at: message.timestamp, direction: "sent", text: "" });
      }
    }
  }
  return contacts;
}

/**
 * The sessions a transcript created and every agent message in it, read once per messages array. The hub replaces a chat's array on each new
 * message, and the catalog asks for every chat on every projection: on 10-18 these two scans of about 1,000 messages per chat took 30% of
 * chatAgents.
 */
const transcriptReads = new WeakMap<readonly ThreadMessage[], { created: string[]; contacts: Contact[] }>();
function transcriptLinks(messages: readonly ThreadMessage[]): { created: string[]; contacts: Contact[] } {
  let read = transcriptReads.get(messages);
  if (!read) {
    read = { created: createdSessions(messages).map(created => created.sessionId), contacts: agentContacts(messages, -Infinity) };
    transcriptReads.set(messages, read);
  }
  return read;
}

/** A name in the owner's style: plain words with spaces. Empty, "Untitled" and kebab-case or snake_case names get a derived display name. */
export const needsDisplayName = (name: string): boolean => {
  const trimmed = name.trim();
  return !trimmed || /^untitled$/i.test(trimmed) || /^[^\s]*[A-Za-z0-9][-_][A-Za-z0-9][^\s]*$/.test(trimmed);
};
/** A label a brief opens a line with: "[task from parent]", "Owner's words (verbatim, relayed):", "My read (crawler ops):", answering "...". */
const LABEL = /^(?:\[task from parent\]\s*|[^:\n"]{0,60}?\b(?:words|read)\b\s*(?:\([^)]*\))?\s*(?:,\s*answering\s+"[^"]*")?\s*:\s*)/i;
/** The line that holds the chat's own reading of the task; a brief's best topic line. */
const MY_READ = /^\s*my read\b[^:\n]*:\s*(.+)$/im;
/** A quoted line, a markup or tag line (a skill block, an HTML tag), a rule or a fence: not a name. */
const QUOTE_LINE = /^(?:["'“‘>]|---|```|<)/;
/** Openers that carry no topic, longest first so "have a look at" wins over "look". Stripped again until none is left. */
const FILLER = ["have a careful read at", "have a look at", "take a look at", "i want you to", "i need you to", "your job is to", "your job is", "look there are",
  "there are a bunch of", "there are", "there is", "there's", "there were", "there was", "the owner wants", "can you please", "could you please", "can you", "could you", "can we", "please",
  "i want to", "i want", "you are", "you're", "we need to", "make sure", "look at", "look", "lets", "let's", "hey", "yo", "so", "ok", "okay", "btw", "bytheway", "hi", "also", "now", "and"];
const FILLER_HEAD = new RegExp(`^(?:${FILLER.map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b[\\s,:]*`, "i");
/** Words with no topic of their own: dropped at either end of a name, and inside it when it is longer than NAME_WORDS. */
const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "at", "for", "with", "and", "or", "by", "from", "into", "is", "are", "be", "it", "its", "this", "that", "these",
  "those", "my", "our", "your", "i", "we", "you", "me", "us", "do", "how", "what", "which", "why", "every", "all", "some", "any", "bunch", "couple", "lot", "something", "single", "much"]);
/** A heading of this many words or fewer is a brief's section title ("# Context", "# Poteto subagent"), not its topic. */
const SECTION_WORDS = 3;

/** A brief's body: the part after a "Task" heading when it has one, else the text after a front-matter block. */
function briefBody(first: string): string {
  const task = /^#{1,3}\s*(?:task|asks?)\b[^\n]*\n/im.exec(first);
  if (task) return first.slice(task.index + task[0].length);
  return first.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "");
}
/** A line with its label, list mark, slash command and a leading "Name," cut; empty when it is a quote, a tag, a section heading or a placeholder. */
function topicLine(raw: string): string {
  let line = raw.trim().replace(LABEL, "").replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/^\/[\w:-]+\s*/, "").trim();
  if (!line || QUOTE_LINE.test(line) || /^\(no messages\)$/i.test(line)) return "";
  const heading = /^#+\s*(.*)$/.exec(line);
  if (heading) { line = heading[1]!; if (line.split(/\s+/).length <= SECTION_WORDS) return ""; }
  return line.replace(/^[A-Z][a-z]+,\s+/, "");
}
/** A URL as the last part of its path ("http://localhost:5176/specs" is "specs"); empty for a bare host. */
const urlWord = (url: string): string => { try { return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? ""; } catch { return ""; } };
/**
 * Topic words of a line, lowercase: links and URLs cut to their text or last path part, paths, parentheses, markdown marks and quotes dropped,
 * filler openers cut, then only the first clause when it holds two or more words that are not stop words.
 */
function topicWords(line: string): string[] {
  let text = line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/[^\s)>"']+/g, url => ` ${urlWord(url.replace(/[.,;:!?]+$/, ""))} `).replace(/\S*\/\S+/g, " ")
    .replace(/\([^)]*\)/g, " ").replace(/<[^>]*>/g, " ").replace(/[`*_#>|"“”‘’[\]{}]/g, " ").replace(/\s+/g, " ").trim();
  for (let before = ""; before !== text; ) { before = text; text = text.replace(FILLER_HEAD, "").trim(); }
  const clause = /^(.*?)(?:[.?!;](?:\s|$)|,\s|\s(?:and|but|so|then)\s)/i.exec(text);
  const head = clause && clause[1]!.split(" ").filter(word => !STOP.has(word.toLowerCase())).length >= 2 ? clause[1]! : text.split(/[.?!;](?:\s|$)/)[0]!;
  return head.toLowerCase().replace(/[,:;.!?]+/g, " ").split(/\s+/).filter(word => /[a-z0-9]/.test(word));
}
/** At most NAME_WORDS words with no stop word at either end; stop words inside go first when there are more. */
function nameOf(words: readonly string[]): string {
  let kept = [...words];
  while (kept.length && STOP.has(kept[0]!)) kept.shift();
  if (kept.length > NAME_WORDS) kept = kept.filter(word => !STOP.has(word));
  kept = kept.slice(0, NAME_WORDS);
  while (kept.length && STOP.has(kept.at(-1)!)) kept.pop();
  return kept.join(" ");
}
/**
 * A short topic name from a first task or brief: the "My read" line when it has one, else its first line that is not a label, a quote, a tag or a
 * section heading; filler openers ("have a look at", "can you", "your job is") and stop words at its ends cut, at most NAME_WORDS words, lowercase.
 * Empty when nothing is left.
 */
export function derivedName(first: string): string {
  const body = briefBody(first);
  const read = MY_READ.exec(body)?.[1];
  for (const line of [...(read ? [read] : []), ...body.split("\n")]) {
    const name = nameOf(topicWords(topicLine(line)));
    if (name) return name;
  }
  return "";
}
/** A given name with markdown marks around or inside it removed: "**** main dev thread ***" is "main dev thread". */
const plainName = (name: string): string => name.replace(/[*`]+/g, " ").replace(/^[\s#_~>]+|[\s_~]+$/g, "").replace(/\s+/g, " ").trim();
const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
/**
 * `squash(text)` cut to its first `length` characters, squashing only as much of the text as that needs: a first task runs to 2,000 characters,
 * and on 10-18 squashing each one whole for every row a chat's agents named took 9% of a catalog projection.
 */
function squashedHead(text: string, length: number): string {
  for (let read = 2 * length + 16; ; read *= 2) {
    const head = squash(text.slice(0, read));
    if (read >= text.length || head.length > length) return head.slice(0, length);
  }
}
/**
 * Whether a row's name is a title the catalog took from its first message, not one the owner gave: longer than six words, or three or more words
 * that open the first message.
 */
export function titledFromMessage(name: string, first: string | undefined): boolean {
  const words = name.trim().split(/\s+/).length;
  if (words > 6) return true;
  if (words < 3 || first === undefined) return false;
  const opening = squash(name);
  return squashedHead(first, opening.length) === opening;
}
/** A name the chat server made up ("chat-e15f") or the daemon's "Untitled": it names no topic. */
const generatedName = (name: string): boolean => !name || /^untitled$/i.test(name) || /^chat-[0-9a-f]{4}$/i.test(name);
/** A kebab-case or snake_case job name as words, with trailing number parts dropped: "settings-reland-2" is "settings reland". */
function kebabWords(name: string): string {
  const parts = name.split(/[-_]+/).filter(Boolean);
  while (parts.length > 1 && /^\d+$/.test(parts.at(-1)!)) parts.pop();
  return parts.join(" ");
}
/**
 * The name a row shows. A name the owner gave stays, without markdown marks. A kebab-case job name reads as its words. A made-up name
 * ("chat-e15f", "Untitled", none) or a title the catalog took from the first message gets a topic name derived from the first task, else
 * from that title.
 */
export function displayName(name: string, first: string | undefined): string {
  let byFirst = displayNames.get(name);
  if (!byFirst) { byFirst = new Map(); displayNames.set(name, byFirst); }
  let shown = byFirst.get(first);
  if (shown === undefined) { shown = nameFor(name, first); byFirst.set(first, shown); }
  return shown;
}
/**
 * `displayName` by name and first task. It is a pure function of the two, and every chat asked it again for each of its agents on each
 * catalog projection: 2.9 s of a 131 s scratch-serve profile on 10-18. Both strings come from the daemon's rows and the first-task cache, so
 * the map grows only with the sessions this service has seen.
 */
const displayNames = new Map<string, Map<string | undefined, string>>();
function nameFor(name: string, first: string | undefined): string {
  const plain = plainName(name);
  if (!generatedName(plain) && needsDisplayName(plain)) return kebabWords(plain);
  const titled = !generatedName(plain) && titledFromMessage(plain, first);
  if (!generatedName(plain) && !titled) return plain;
  return (first && derivedName(first)) || (titled ? derivedName(plain) : "") || plain || "untitled";
}

type Draft = {
  key: string; sessionId?: string; childId?: string; name: string; job: string; sender: string; link: AgentLink; working: boolean; failed: boolean; ended: boolean;
  activity: string; at: number; steps: string[]; contacts: Contact[]; names: Set<string>; subagents: number; total: number;
};
const LINK_RANK: Record<AgentLink, number> = { subagent: 0, root: 1, step: 2, message: 3 };
const OPEN = new Set(["todo", "doing", "blocked"]);
const atOf = (value: string | number | undefined): number => typeof value === "number" ? value : Date.parse(value ?? "") || 0;

/**
 * `stepOwner` per plan item, read again only when the item's job, session id or note changes. Every chat walked its whole plan on each catalog
 * projection: 1.2 s of 100 s of a 10-18 scratch-serve profile.
 */
const stepOwners = new WeakMap<PlanItem, { job: string | undefined; sessionId: string | undefined; note: string | undefined; owner: string | undefined }>();
function ownerName(item: PlanItem): string | undefined {
  const known = stepOwners.get(item);
  if (known && known.job === item.job && known.sessionId === item.sessionId && known.note === item.note) return known.owner;
  const owner = stepOwner(item);
  stepOwners.set(item, { job: item.job, sessionId: item.sessionId, note: item.note, owner });
  return owner;
}

function walk(items: readonly PlanItem[], visit: (item: PlanItem) => void): void {
  for (const item of items) { visit(item); walk(item.children, visit); }
}

/**
 * Looks a row up by session id or name, as the first row that has either, the way `rows.find` would. The index is built once per rows array,
 * which every chat of one catalog projection shares: on 10-18 a linear find per open plan step over 2,582 rows took 45% of chatAgents and a
 * fifth of the chat service's main thread.
 */
const rowIndexes = new WeakMap<readonly AgentRow[], { byId: Map<string, number>; byName: Map<string, number> }>();
function rowFinder(rows: readonly AgentRow[]): (who: string) => AgentRow | undefined {
  let index = rowIndexes.get(rows);
  if (!index) {
    index = { byId: new Map(), byName: new Map() };
    for (const [at, entry] of rows.entries()) {
      if (!index.byId.has(entry.row.id)) index.byId.set(entry.row.id, at);
      if (!index.byName.has(entry.row.name)) index.byName.set(entry.row.name, at);
    }
    rowIndexes.set(rows, index);
  }
  const { byId, byName } = index;
  return who => {
    const at = Math.min(byId.get(who) ?? Infinity, byName.get(who) ?? Infinity);
    return at === Infinity ? undefined : rows[at];
  };
}

/**
 * Every thread linked to a chat, running first, then by latest activity: its subagents (the hub's snapshots joined with the daemon's sessions
 * under it), the roots it started with rlm.create_session (the registry and the handles in its transcript), the owners of its open plan steps,
 * and the threads it exchanged agent messages with in the last CONTACT_WINDOW_MS. One row per thread, linked the strongest way it is. A row is
 * working while its own turn or any subagent below it runs, as `SessionRow.working` is.
 */
export function chatAgents(input: AgentSources): ChatAgent[] {
  const drafts: Draft[] = [];
  const bySession = new Map<string, Draft>();
  const byName = new Map<string, Draft>();
  const index = (draft: Draft) => {
    drafts.push(draft);
    if (draft.sessionId) bySession.set(draft.sessionId, draft);
    for (const name of draft.names) if (name) byName.set(name, draft);
  };
  const find = (who: string): Draft | undefined => {
    const raw = who.replace(/^(?:child|sibling|parent):/, "").replace(/^thread:/, "").trim();
    return bySession.get(raw) ?? byName.get(raw);
  };
  const rowOf = rowFinder(input.rows);
  const link = (draft: Draft, how: AgentLink) => { if (LINK_RANK[how] < LINK_RANK[draft.link]) draft.link = how; };

  const sessions = new Map(input.childSessions.map(session => [session.childId ?? session.sessionId, session]));
  const childIds = new Set(input.children.map(child => child.id));
  for (const child of input.children) {
    if (child.parentId !== undefined && childIds.has(child.parentId)) continue;
    const session = sessions.get(child.id) ?? input.childSessions.find(candidate => candidate.name !== undefined && candidate.name === child.sessionName);
    const name = childName(child);
    const working = child.status === "running" || child.status === "queued" || (session ? session.running : childWorking(child));
    index({ key: "child:" + child.id, ...(session ? { sessionId: session.sessionId } : {}), childId: child.id, name: displayName(name, session?.first ?? child.label), job: name, sender: name,
      link: "subagent", working, failed: !working && (child.status === "error" || session?.failed === true), ended: !working,
      activity: working ? session?.activity ?? "" : child.error ?? session?.activity ?? child.answerPreview ?? "", at: Math.max(child.lastActivityAt ?? 0, atOf(session?.lastActivityAt)),
      steps: [], contacts: [], names: new Set([name, child.id, child.sessionName ?? ""]), subagents: session?.subagentsRunning ?? 0,
      total: session?.subagentsTotal ?? 0 });
  }
  for (const session of input.childSessions) {
    if ((session.childId && bySession.has(session.sessionId)) || drafts.some(draft => draft.sessionId === session.sessionId)) continue;
    // One row per child id, also when the daemon lists two sessions of one child (a resumed job): two rows under one key threw
    // each_key_duplicate in the board panel on every switch to the AI harness chat (10-18, child:sub-3945faa4 at rows 0 and 134).
    const listed = session.childId ? drafts.find(draft => draft.childId === session.childId) : undefined;
    if (listed) { if (!listed.sessionId) { listed.sessionId = session.sessionId; bySession.set(session.sessionId, listed); } continue; }
    const name = session.name ?? "";
    index({ key: "child:" + (session.childId ?? session.sessionId), sessionId: session.sessionId, ...(session.childId ? { childId: session.childId } : {}),
      name: displayName(name, session.first), job: name || session.sessionId, sender: name || session.sessionId, link: "subagent", working: session.running, failed: session.failed, ended: !session.running,
      activity: session.activity ?? "", at: atOf(session.lastActivityAt), steps: [], contacts: [], names: new Set([name, session.childId ?? ""]), subagents: session.subagentsRunning ?? 0,
      total: session.subagentsTotal ?? 0 });
  }

  const thread = (entry: AgentRow, how: AgentLink): Draft | undefined => {
    if (entry.row.id === input.self.id) return undefined;
    const known = bySession.get(entry.row.id);
    if (known) { link(known, how); return known; }
    const row = entry.row;
    const draft: Draft = { key: "thread:" + row.id, sessionId: row.id, name: displayName(row.name, entry.first), job: "session:" + row.id, sender: row.name, link: how, working: row.working,
      failed: !row.working && Boolean(row.failure), ended: false, activity: row.working ? row.statusLabel ?? "" : row.failure ?? "", at: atOf(row.lastActivityAt ?? row.created),
      steps: [], contacts: [], names: new Set([row.name]), subagents: row.subagentsRunning, total: row.subagentsRunning };
    index(draft);
    return draft;
  };
  const transcript = transcriptLinks(input.messages);
  const roots = new Set([...input.roots, ...transcript.created]);
  for (const root of roots) { const entry = rowOf(root); if (entry) thread(entry, "root"); }

  // Owners of open steps join the list; then every step of a listed thread, done ones included, is counted on it. A step's stored session id
  // finds its thread first, so the step keeps its owner when its job is renamed or deleted; a deleted one gets an ended row of its own.
  const owned: PlanItem[] = [];
  const ownerOf = (item: PlanItem): Draft | undefined => {
    const name = ownerName(item);
    return (item.sessionId ? bySession.get(item.sessionId) : undefined) ?? (name !== undefined ? find(name) : undefined);
  };
  const gone = (item: PlanItem, id: string): Draft | undefined => {
    const entry = rowOf(id);
    if (entry) return thread(entry, "step");
    const name = item.job && item.job !== id ? item.job : id;
    const draft: Draft = { key: "thread:" + id, sessionId: id, name: name === id ? `thread ${id.slice(0, 8)}` : displayName(name, undefined), job: "session:" + id, sender: name, link: "step", working: false, failed: false,
      ended: true, activity: "", at: 0, steps: [], contacts: [], names: new Set([name]), subagents: 0, total: 0 };
    index(draft);
    return draft;
  };
  walk(input.board?.plan ?? [], item => {
    const owners = [item.sessionId, ownerName(item)].filter((who): who is string => who !== undefined);
    if (!owners.length || owners.some(who => who === input.self.id || who === input.self.name)) return;
    owned.push(item);
    if (OPEN.has(item.status) && !ownerOf(item)) { const entry = owners.map(rowOf).find(Boolean); if (entry) thread(entry, "step"); }
  });
  for (const item of owned) {
    const draft = ownerOf(item) ?? (item.sessionId ? gone(item, item.sessionId) : undefined);
    if (!draft) continue;
    link(draft, "step");
    draft.steps.push(item.id);
  }

  const since = input.now - CONTACT_WINDOW_MS;
  for (const contact of transcript.contacts) {
    if (contact.at < since) continue;
    let draft = find(contact.who);
    if (!draft) {
      const raw = contact.who.replace(/^(?:child|sibling|parent):/, "").trim();
      if (!raw || raw === input.self.id || raw === input.self.name || contact.who.startsWith("child:")) continue;
      const entry = rowOf(raw);
      if (!entry) continue;
      draft = thread(entry, "message");
    }
    if (!draft) continue;
    link(draft, "message");
    draft.contacts.push(contact);
  }

  const agents = drafts.map((draft): ChatAgent => {
    const last = draft.contacts.sort((left, right) => left.at - right.at).at(-1);
    const received = draft.contacts.filter(contact => contact.direction === "received").at(-1);
    const working = draft.working || draft.subagents > 0;
    const waiting = !working && !draft.failed && last?.direction === "received" && /\?/.test(last.text);
    const state: AgentState = working ? "working" : draft.failed ? "failed" : waiting ? "waiting" : draft.ended ? "done" : "idle";
    const activity = (working || draft.failed ? draft.activity : received?.text || draft.activity).replace(/\s+/g, " ").trim().slice(0, 200);
    const at = Math.max(draft.at, last?.at ?? 0);
    return { key: draft.key, ...(draft.sessionId ? { sessionId: draft.sessionId } : {}), ...(draft.childId ? { childId: draft.childId } : {}), name: draft.name, job: draft.job, sender: draft.sender,
      link: draft.link, state, ...(activity ? { activity } : {}), ...(at ? { lastActivityAt: new Date(at).toISOString() } : {}), steps: draft.steps,
      ...(draft.subagents ? { subagentsRunning: draft.subagents } : {}), ...(draft.total ? { subagentsTotal: draft.total } : {}) };
  });
  const at = new Map(agents.map(agent => [agent, atOf(agent.lastActivityAt)]));
  return agents.sort((left, right) => Number(right.state === "working") - Number(left.state === "working") || at.get(right)! - at.get(left)!);
}

/**
 * The chat's subagents on its row (`agents`, from the daemon's sessions under it) as hub child snapshots, for a chat the hub has not attached
 * on this serve: the hub sends child snapshots only after an attach (frontend bro 10-13: every pin timed out on its 64 MB transcript after the
 * 14:00Z restart, and the check-in flagged p92 to p99 "(<job> not found)" while the daemon listed each job under the chat, 5 of them at work).
 */
export function agentChildren(agents: readonly ChatAgent[]): ChildAgent[] {
  return agents.flatMap((agent): ChildAgent[] => {
    if (agent.link !== "subagent" || agent.childId === undefined) return [];
    const at = Date.parse(agent.lastActivityAt ?? "");
    return [{ id: agent.childId, label: agent.name, sessionName: agent.job, status: agent.state === "working" ? "running" : agent.state === "failed" ? "error" : "done",
      ...(Number.isFinite(at) ? { lastActivityAt: at } : {}) }];
  });
}

/**
 * The session ids the board should keep (`BoardStore.linkSessions`): each step with a job and no session id yet whose owner agent has a session,
 * by step id, with the job it names.
 */
export function stepSessions(board: ChatBoard | null, agents: readonly ChatAgent[]): Map<string, { job: string; sessionId: string }> {
  const owners = new Map(agents.flatMap(agent => agent.sessionId ? agent.steps.map(step => [step, agent.sessionId!] as const) : []));
  const links = new Map<string, { job: string; sessionId: string }>();
  walk(board?.plan ?? [], item => {
    const sessionId = owners.get(item.id);
    if (item.job && !item.sessionId && sessionId) links.set(item.id, { job: item.job, sessionId });
  });
  return links;
}

const STATE_WORD: Record<AgentState, string> = { working: "working", waiting: "waiting for you", idle: "idle", done: "done", failed: "failed" };
function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
/** A queued turn in words: "queued 3 of 7 for a working slot, waiting 4 min". */
const queuedWords = (place: QueuePlace, now: number): string => `queued ${place.position} of ${place.total} for a working slot, waiting ${ago(now - place.since)}`;
/** The chat_board tool's "Agents:" section: one line per agent (name, state, age), every agent listed. Empty with no agent. */
export function agentLines(agents: readonly ChatAgent[], now: number): string[] {
  if (!agents.length) return [];
  return ["Agents:", ...agents.map(agent => `- ${agent.name}: ${agent.queued ? queuedWords(agent.queued, now) : agent.wait ?? STATE_WORD[agent.state]}${agent.lastActivityAt ? `, ${ago(now - atOf(agent.lastActivityAt))} ago` : ""}${agent.steps.length ? ` (${agent.steps.join(", ")})` : ""}`)];
}

/** The agents with their place in the Mac-wide turn queue attached, for the sessions `pi-pool queue --json` lists as queued. */
export function withQueue(agents: readonly ChatAgent[], places: ReadonlyMap<string, QueuePlace>): ChatAgent[] {
  return agents.map(agent => { const queued = agent.sessionId ? places.get(agent.sessionId) : undefined; return queued ? { ...agent, queued } : agent; });
}

/**
 * The agents not at work whose session or a session below it (`below`, `treeWakes`) has a pending board.wake: state working, the check-in's rule
 * for a job asleep on a wake (`withWakes`), with the wait in words (`wakeWait`). Crawler VP 10-18 03:00Z: the agents API gave query mcp build,
 * census canary run and crawler ops train state "done" while each slept on its run and time wakes.
 */
export function withWaits(agents: readonly ChatAgent[], wakes: readonly Wake[], below: (session: string) => readonly string[]): ChatAgent[] {
  if (!wakes.length) return [...agents];
  return agents.map(agent => {
    const owed = agent.sessionId && agent.state !== "working" ? treeWakes(agent.sessionId, below, wakes) : [];
    return owed.length ? { ...agent, state: "working", wait: wakeWait(owed) } : agent;
  });
}

/** The agents with their output rates attached, for the session ids the usage store answered for. */
export function withRates(agents: readonly ChatAgent[], rates: Readonly<Record<string, TokenRate>>): ChatAgent[] {
  return agents.map(agent => { const rate = agent.sessionId ? rates[agent.sessionId] : undefined; return rate ? { ...agent, rate } : agent; });
}
