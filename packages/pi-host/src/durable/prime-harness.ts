/**
 * Prime's harness digest in a durable thread: the same text, placed where Prime places it, from the same stores.
 *
 * Prime (agent-session.ts `_nextHarnessDigestMessage`) checks the harness at each turn it starts. A context with no digest gets the full
 * `[harness-digest]` message before the turn's input; a context whose newest digest has another state fingerprint gets a
 * `[harness-digest update]` with the lines that changed, and earlier digests stay where they are, so the cached prefix holds. The state is
 * the global store merged with the session's local one, and the entries are ranked by the turn's input, the goal and the last four
 * messages. A conversation's local store is its thread's own (`threadHarnessDir`), or, in a thread that belongs to an agent, the agent's
 * store, which every conversation of that thread shares (`agent-profile.ts` `conversationHarnessDir`). All of it runs here with Prime's
 * own code (`vendor/prime-harness.ts`, copied by `scripts/vendor-prime-harness.mjs`).
 *
 * pi-durable stores no message that is not an entry, and an entry with a user message would show in the chat and its search as one the owner
 * sent. So each delivery goes in the conversation's `prime.harness-digests` document, anchored after the newest entry the context held, and a
 * `beforeRequest` hook puts it into every request as its own user message before the first input after that anchor. The text and the place
 * never change afterwards, as a Prime digest message's do not, so the cached prefix holds. A compaction ends the deliveries before it, and
 * the next input gets the full digest again.
 */
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { defineDoc, type ContextView, type EntryRecord } from "@earendil-works/pi-durable";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  formatHarnessDigestDelta, formatHarnessStateForPrompt, getGlobalHarnessStateDir, getHarnessStatePath, getLocalHarnessStateDir, HARNESS_DIGEST_DELTA_PREFIX,
  HARNESS_DIGEST_DELTA_SUFFIX, HARNESS_DIGEST_PREFIX, HARNESS_DIGEST_SUFFIX, harnessDigestFingerprint, harnessDigestQueryTerms, harnessEntryMalformation,
  loadHarnessState, mergeHarnessStates, scoreHarnessEntries, type HarnessEntry, type HarnessQueryTerms, type HarnessState, type RefinementKind,
} from "./vendor/prime-harness.ts";
import { changedMemory, countMemory, getMemory, listMemory, memoryRevision, recentMemory, searchMemory } from "../../../pi-harness/src/core/memory-store.ts";

/** One digest the conversation got: Prime's digest message content (`text`) and details, and the entry it was sent after. */
export type DigestDelivery = {
  /** The newest entry of the context when it was sent, or 0 for an empty context. It goes before the first input after that entry. */
  after: number;
  /** Prime's message timestamp, which the next delta reads changes since. */
  at: number;
  text: string;
  /** The full digest, also for an update whose text shows only the change. */
  digest: string;
  stateFingerprint: string;
  stacked?: true;
};

export const HarnessDigestDoc = defineDoc<{ deliveries: DigestDelivery[] }>({
  kind: "prime.harness-digests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ deliveries: [] }),
  checkpointWhen: () => true,
});

/** The render flags Prime's `_harnessDigestMaterial` sets from the session's tools and the skills the model sees. */
export type DigestFlags = { includeIpythonExamples: boolean; includeShellExamples: boolean; includeRefineExamples: boolean };
export function digestFlags(tools: readonly string[], skills: readonly { name: string; disableModelInvocation?: boolean }[]): DigestFlags {
  const ipython = tools.includes("ipython");
  return {
    includeIpythonExamples: ipython,
    includeShellExamples: tools.includes("bash"),
    includeRefineExamples: ipython && skills.some(skill => !skill.disableModelInvocation && skill.name === "refine"),
  };
}

/**
 * A thread conversation's local harness store, by Prime's rule for a session (`getLocalHarnessStateDir(getSessionArtifactPath(...))`): the
 * `harness` folder of `session-artifacts/<id>` next to the sessions folder, here the threads folder. The root conversation's id is the
 * thread's; a child conversation's is `<thread>-<conversation>`, the name its job_reply guideline gives its scratch folder. Prime's kernel
 * writes the same file through `RLM_HARNESS_STATE_DIR`.
 */
export function threadHarnessDir(threadFile: string, sessionId: string): string {
  return getLocalHarnessStateDir(join(dirname(dirname(threadFile)), "session-artifacts", sessionId))!;
}

const states = new Map<string, { identity: string; state: HarnessState }>();
/** Prime's `_harnessStateFilesIdentity`: inode, size and change times of each store, which `saveHarnessState` replaces by rename. */
const identityOf = (dirs: readonly string[]): string => dirs.map(dir => {
  const stats = statSync(getHarnessStatePath(dir), { throwIfNoEntry: false });
  return stats ? `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}` : "none";
}).join("|");

/**
 * Prime's `_loadMergedHarnessState`: the global store with the session's local one over it, read again only when a file changed. A local
 * store keeps its memory entries in `memory.sqlite` (pi-harness `memory-store.ts`); `withMemory` adds them, as a thread's own small store
 * needs, while an agent's store, which can hold tens of thousands, leaves them to `formatDigest`'s ranked search.
 */
export function mergedHarnessState(agentDir: string, localDir?: string, withMemory = false): HarnessState {
  const globalDir = getGlobalHarnessStateDir(agentDir);
  const key = `${globalDir}\0${localDir ?? ""}\0${withMemory}`;
  const identity = identityOf(localDir ? [globalDir, localDir] : [globalDir]) + (localDir && withMemory ? `|${memoryRevision(localDir)}` : "");
  const kept = states.get(key);
  if (kept?.identity === identity) return kept.state;
  const local = localDir ? loadHarnessState(localDir, "local") : undefined;
  if (local && localDir && withMemory) {
    for (const entry of listMemory(localDir)) {
      if ((local.entries.memory[entry.id]?.updated_at ?? "") <= entry.updated_at) local.entries.memory[entry.id] = entry as unknown as HarnessEntry;
    }
  }
  const state = mergeHarnessStates(loadHarnessState(globalDir, "global"), local);
  states.set(key, { identity, state });
  return state;
}

const textOf = (content: UserMessage["content"]): string => typeof content === "string" ? content
  : content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");

/**
 * Prime's `harnessQueryMessageText` over a durable entry's message: an assistant's text, and a user message's text unless the entry is a
 * compaction summary, which Prime holds as a `compactionSummary` message it does not read.
 */
export function queryText(entry: EntryRecord, message: Message): string {
  if (message.role === "assistant") return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
  if (message.role === "user" && entry.kind !== "pi.compaction") return textOf(message.content);
  return "";
}

/** Prime's `_buildHarnessDigestQueryTerms`: the turn's input at weight 4, the goal at 3, then the last four messages, newest first. */
export function digestQueryTerms(input: readonly string[], recent: readonly string[], goal = ""): HarnessQueryTerms {
  const last = recent.filter(Boolean).slice(-4).reverse();
  return harnessDigestQueryTerms([
    { text: [...input].reverse().join("\n"), weight: 4 },
    { text: goal, weight: 3 },
    ...last.map((text, index) => ({ text, weight: Math.max(1, 2 - index * 0.5) })),
  ]);
}

/**
 * Prime's `_nextHarnessDigestMessage`: the full digest for a context with none, nothing when the newest one has the state's fingerprint,
 * else an update with the change (or the full digest when the change has no line). `delivered` are the deliveries in context, oldest first.
 *
 * In an agent's thread (`memory` set) each later input also brings up to `TURN_RECALL_ENTRIES` memory entries that match it and that no
 * delivery in the context holds yet, and every shown entry changed since the last delivery, in an update of their own lines.
 */
export function nextDelivery(input: {
  state: HarnessState; flags: DigestFlags; input: readonly string[]; recent: readonly string[]; delivered: readonly DigestDelivery[]; after: number; now: number;
  /** The conversation's goal objective, which Prime ranks entries by at weight 3. */
  goal?: string;
  /** The agent whose store is the local one (`formatDigest`). */
  agent?: string;
  /** The agent's memory store folder, the `memory.sqlite` its block ranks. */
  memoryDir?: string;
}): DigestDelivery | undefined {
  const stateFingerprint = harnessDigestFingerprint(input.state, input.flags);
  const latest = input.delivered.at(-1);
  const memory = input.agent && input.memoryDir ? { dir: input.memoryDir, query: memoryQuery(input.input, input.recent, input.goal) } : undefined;
  const recall = memory && latest ? turnRecall(memory, input.delivered) : [];
  // Ranking a large store takes most of a second, so a fresh context skips it; Prime renders first and compares after, with the same result.
  if (latest?.stateFingerprint === stateFingerprint && !recall.length) return undefined;
  const digest = formatDigest(input.state, { ...input.flags, queryTerms: digestQueryTerms(input.input, input.recent, input.goal) }, input.agent, memory);
  const full = HARNESS_DIGEST_PREFIX + digest + HARNESS_DIGEST_SUFFIX;
  if (!latest) return { after: input.after, at: input.now, text: full, digest, stateFingerprint };
  const delta = latest.stateFingerprint === stateFingerprint ? undefined : formatHarnessDigestDelta(input.state, input.delivered.map(delivery => delivery.text), latest.at);
  if (delta === undefined && latest.stateFingerprint !== stateFingerprint) return { after: input.after, at: input.now, text: full, digest, stateFingerprint, stacked: true };
  const recallText = recall.length ? [`Agent ${input.agent}'s memory entries that match this input:`, ...recall.map(agentLine)].join("\n") : "";
  const text = HARNESS_DIGEST_DELTA_PREFIX + [recallText, delta ?? ""].filter(Boolean).join("\n\n") + HARNESS_DIGEST_DELTA_SUFFIX;
  return { after: input.after, at: input.now, text, digest, stateFingerprint, stacked: true };
}

const AGENT_LINE_ID = /^- \[agent:([^\]]+)\] /gm;

/** The memory entries the next input should bring: the best matches no delivery shows yet, then shown entries changed since the last one. */
function turnRecall(memory: AgentMemory, delivered: readonly DigestDelivery[]): HarnessEntry[] {
  const shown = new Set(delivered.flatMap(delivery => [...delivery.text.matchAll(AGENT_LINE_ID)].map(match => match[1]!)));
  const since = new Date(delivered.at(-1)!.at).toISOString();
  const fresh = rankMemory(memory.dir, memory.query, TURN_RECALL_ENTRIES + shown.size).filter(entry => !shown.has(entry.id)).slice(0, TURN_RECALL_ENTRIES);
  const changed = changedMemory(memory.dir, since).filter(entry => shown.has(entry.id));
  return [...fresh, ...changed];
}

/**
 * Prime's two lines on scope, which read the local store as one session's. In a thread that belongs to an agent the local store is the
 * agent's memory, which every thread and job of the agent reads, so `formatDigest` puts `agentScopeLines` in their place.
 */
const PRIME_SCOPE_LINES = [
  "Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
  "Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
] as const;

/** What an agent keeps in its own memory and what it leaves out, said where the model reads its memory (c130). */
export function agentScopeLines(agent: string): [string, string] {
  return [
    `Local entries are agent ${agent}'s own memory: every thread and job of ${agent} reads them in this digest, in any later week. \`rlm.harness\` writes there unless you pass \`global_=True\`, and so does \`await refine.run()\`. Global entries are shared by every agent and Prime chat.`,
    `Save to ${agent}'s memory, in the turn you learn it, each fact ${agent} needs again in a later thread: an owner rule or correction for its work in his words with its message id, a console URL and how to sign in (where a secret lives, never its value), a release or deploy command, and how one of its systems works. ` +
      `First look for the entry that covers the point with \`rlm.harness.search("<topic words>", "memory")\`, then call \`rlm.harness.update_memory(id, title, content)\` on it or \`rlm.harness.create_memory(title, content)\` for a new one; these calls are synchronous and take no \`await\`. Put the fact first and keep an entry under 600 characters, the length this block shows. ` +
      `Keep step status, progress, open waits and session notes on the board, never in memory. Use \`global_=True\` only for a lesson every agent needs.`,
  ];
}

/**
 * The agent block shows the 40 memory entries that best match the turn, drawn from the whole store (`memory.sqlite`, which holds tens of
 * thousands), with Prime's six ranked lines of 180 characters per kind kept for the global store. On the 30 recall questions of
 * ~/work/agent-memory-scale (11-26), the right entry was in the top 40 for 25 of 30 at 10,000 entries and 23 of 30 at 50,000.
 */
const AGENT_BLOCK_ENTRIES = 40;
/** Each later input adds up to this many entries that match it and that the context has not shown yet (`nextDelivery`). */
const TURN_RECALL_ENTRIES = 8;
const AGENT_BLOCK_CONTENT = 600;
const AGENT_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

const compact = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
};

/** Texts a memory search ranks by, each with its weight: the turn's input, the goal, the last messages. */
export type MemoryQuery = readonly { text: string; weight: number }[];

/** `digestQueryTerms`'s sources as texts: the turn's input at weight 4, the goal at 3, then the last four messages, newest first. */
export function memoryQuery(input: readonly string[], recent: readonly string[], goal = ""): MemoryQuery {
  const last = recent.filter(Boolean).slice(-4).reverse();
  return [{ text: [...input].reverse().join("\n"), weight: 4 }, { text: goal, weight: 3 }, ...last.map((text, index) => ({ text, weight: Math.max(1, 2 - index * 0.5) }))]
    .filter(source => source.text.trim());
}

/**
 * The `limit` memory entries of the store in `dir` that best match `query`: one BM25 search per text, fused by weighted reciprocal rank,
 * so the turn's input counts most. With no query text, the newest entries. Entries a store's file still holds (`legacy`) rank with them.
 */
export function rankMemory(dir: string | undefined, query: MemoryQuery, limit: number, legacy: readonly HarnessEntry[] = []): HarnessEntry[] {
  const fused = new Map<string, { entry: HarnessEntry; score: number }>();
  const add = (entries: readonly HarnessEntry[], weight: number) => entries.forEach((entry, rank) => {
    const kept = fused.get(entry.id);
    fused.set(entry.id, { entry: kept?.entry ?? entry, score: (kept?.score ?? 0) + weight / (60 + rank) });
  });
  if (legacy.length) {
    const scores = scoreHarnessEntries(legacy, harnessDigestQueryTerms(query));
    add([...legacy].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || a.id.localeCompare(b.id)), 1);
  }
  if (dir) for (const { text, weight } of query) add(searchMemory(dir, text, Math.max(limit, 50)).map(hit => hit.entry), weight);
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score).map(hit => hit.entry);
  if (ranked.length >= limit || !dir) return ranked.slice(0, limit);
  const seen = new Set(ranked.map(entry => entry.id));
  return [...ranked, ...recentMemory(dir, limit).filter(entry => !seen.has(entry.id))].slice(0, limit);
}

/** The agent's prompt notes, skills and subagents (kept in `harness_state.json`), each kind ranked by the query and newest first otherwise. */
function rankAgentEntries(entries: readonly HarnessEntry[], queryTerms: HarnessQueryTerms | undefined): HarnessEntry[] {
  const scores = queryTerms?.size ? scoreHarnessEntries(entries, queryTerms) : new Map<HarnessEntry, number>();
  return AGENT_KINDS.flatMap(kind => entries.filter(entry => entry.kind === kind).sort((a, b) =>
    (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || a.id.localeCompare(b.id)));
}

/**
 * The `limit` local entries nearest `recent`, the last message texts of a conversation, as `<kind>:<id>`: its prompt notes, skills and
 * subagents first, then the memory entries `rankMemory` picks from `localDir`. The auto-refine review shows only these (`refine.ts`).
 */
export function nearestLocal(state: HarnessState, recent: readonly string[], limit: number, localDir?: string): string[] {
  const local = Object.values(state.entries).flatMap(kind => Object.values(kind)).filter(entry => entry.scope === "local");
  const other = rankAgentEntries(local.filter(entry => entry.kind !== "memory"), digestQueryTerms([], recent));
  const memory = rankMemory(localDir, memoryQuery([], recent), limit, local.filter(entry => entry.kind === "memory"));
  return [...other, ...memory].slice(0, limit).map(entry => `${entry.kind}:${entry.id}`);
}

/**
 * The agent's own entries, prompt notes first, each kind ranked by the query when there is one and newest first otherwise. A line names the
 * entry as `[agent:<id>]`, which Prime's delta does not read as one it delivered, so a later change to the entry still shows in the update.
 */
function agentBlock(agent: string, entries: readonly HarnessEntry[], queryTerms: HarnessQueryTerms | undefined, memory: AgentMemory | undefined): string[] {
  const legacy = entries.filter(entry => entry.kind === "memory");
  const total = entries.length - legacy.length + (memory ? countMemory(memory.dir) : 0) + legacy.filter(entry => !memory || !getMemory(memory.dir, entry.id)).length;
  if (!total) {
    return [`## Agent ${agent}'s memory`, "", `${agent} has no saved memory yet. Save the first durable fact or owner rule you learn for its work.`, ""];
  }
  const ranked = [
    ...rankAgentEntries(entries.filter(entry => entry.kind !== "memory"), queryTerms),
    ...rankMemory(memory?.dir, memory?.query ?? [], AGENT_BLOCK_ENTRIES, legacy),
  ].slice(0, AGENT_BLOCK_ENTRIES);
  const lines = [`## Agent ${agent}'s memory (${total} entries; the ${ranked.length} that best match this turn)`, ""];
  for (const entry of ranked) lines.push(agentLine(entry));
  if (total > ranked.length) lines.push(`- +${total - ranked.length} more; find them with \`rlm.harness.search("<topic words>", "memory")\``);
  lines.push("");
  return lines;
}

function agentLine(entry: HarnessEntry): string {
  const bad = harnessEntryMalformation(entry);
  return bad ? `harness: skipped malformed entry ${entry.id} (${bad})` : `- [agent:${entry.id}] ${entry.kind}: ${entry.title}: ${compact(entry.content, AGENT_BLOCK_CONTENT)}`;
}

/** The agent's memory store (`memory.sqlite` in its harness folder) and the texts its block ranks entries by. */
export type AgentMemory = { dir: string; query: MemoryQuery };

/**
 * Prime's digest of `state`, or in an agent's thread (`agent` set) the digest an agent gets: Prime's scope lines replaced by the agent's,
 * the agent's whole store as its own block after the header, and Prime's ranked kind sections over the global entries alone, so the
 * agent's entries do not compete with hundreds of shared ones for six lines.
 */
export function formatDigest(state: HarnessState, options: Parameters<typeof formatHarnessStateForPrompt>[1] & {}, agent?: string, memory?: AgentMemory): string {
  if (!agent) return formatHarnessStateForPrompt(state, options);
  const own: HarnessEntry[] = [];
  const shared: HarnessState = { ...state, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} } };
  for (const kind of Object.keys(state.entries) as RefinementKind[]) {
    for (const [id, entry] of Object.entries(state.entries[kind])) {
      if (entry.scope === "local") own.push(entry);
      else (shared.entries[kind] ??= {})[id] = entry;
    }
  }
  const text = formatHarnessStateForPrompt(shared, options);
  const [scope, keep] = agentScopeLines(agent);
  const lines = text.split("\n").map(line => (line === PRIME_SCOPE_LINES[0] ? scope : line === PRIME_SCOPE_LINES[1] ? keep : line));
  const at = lines.findIndex((line, index) => index > 0 && line === "" && lines[index - 1]?.startsWith("Use these continual harness"));
  const block = agentBlock(agent, own, options.queryTerms, memory);
  return (at < 0 ? [...lines, "", ...block] : [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)]).join("\n").trim();
}

/** An input the model reads as a user message: an owner's or agent's message, an imported Prime custom message. Not a summary or a reset. */
const isInput = (entry: EntryRecord, view: ContextView, index: number): boolean =>
  entry.kind !== "pi.compaction" && entry.kind !== "pi.reset" && view.contributions[index]?.[0]?.role === "user";

/** The deliveries a context whose head marker is `head` still holds: those sent at or after it. */
export const keptDeliveries = (head: number | undefined, deliveries: readonly DigestDelivery[]): DigestDelivery[] =>
  deliveries.filter(delivery => delivery.after >= (head ?? 0));

/**
 * The deliveries the context still holds, each with the index in `view.entries` of the input it goes before, or -1 while that input is
 * still queued. A compaction or reset ends every delivery sent before it, as Prime's rebuilt context keeps no digest message from before
 * its compaction and holds the snapshot instead; here the next input gets the full digest.
 */
export function placeDeliveries(view: ContextView, deliveries: readonly DigestDelivery[]): { delivery: DigestDelivery; before: number }[] {
  return keptDeliveries(view.head?.id as number | undefined, deliveries).map(delivery => ({
    delivery,
    before: view.entries.findIndex((entry, index) => entry.id !== view.head?.id && (entry.id as number) > delivery.after && isInput(entry, view, index)),
  }));
}

/**
 * The request's messages with each placed delivery as a user message right before its input. The message carries no timestamp, as the
 * turn wrappers (`withMessageIds`) mark every timed user message as the owner's, and Prime's digest is a custom message they skip.
 */
export function withDigests(messages: readonly Message[], view: ContextView, deliveries: readonly DigestDelivery[]): Message[] | undefined {
  const byInput = new Map<number, string[]>();
  for (const { delivery, before } of placeDeliveries(view, deliveries)) {
    if (before < 0) continue;
    const stamp = view.contributions[before]?.[0]?.timestamp;
    if (typeof stamp !== "number") continue;
    byInput.set(stamp, [...byInput.get(stamp) ?? [], delivery.text]);
  }
  if (!byInput.size) return undefined;
  const out: Message[] = [];
  for (const message of messages) {
    const texts = message.role === "user" ? byInput.get(message.timestamp) : undefined;
    if (texts) {
      for (const text of texts) out.push({ role: "user", content: [{ type: "text", text }] } as unknown as Message);
      byInput.delete(message.timestamp);
    }
    out.push(message);
  }
  return out;
}
