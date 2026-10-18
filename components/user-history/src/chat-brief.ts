import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cachedJsonFile, type JsonFile, transactJsonFile } from "./locked-json.ts";
import { briefCorrections } from "./chat-corrections.ts";
import { MERGE_RULE_SHORT } from "./shared/chat-board.ts";
import { preApprovalText, releaseGo } from "./shared/release-go.ts";

/** What a chat and its jobs load: the chat brief and its versions, the job guidelines, the extension build hash, and the record of what each chat loaded. */

/** Shell commands a chat may run: prime-agent (stop, send) and quick read-only look-ups. Each entry matches as a whole word at the start. */
export const ALLOWED_SHELL = ["prime-agent", "git log", "git status", "git diff", "git show", "rg", "ls", "cat", "head", "tail", "wc"];
export const SHELL_LIST = "prime-agent, git log/status/diff/show, rg, ls, cat, head, tail, wc";

/** Where the brief's on-demand rules live: the board skill and its references, read before the action they cover. */
export const BOARD_SKILL = "~/.prime/agent/skills/board";
/** The brief, as promptGuidelines bullets. It reaches every turn kind, including agent-message wakes and check-ins, through the base system prompt.
 * A rule the brief holds names its correction id, like (c47); the [corrections] block then shows that id with its theme only (BRIEF_CORRECTIONS). */
export const CHAT_BRIEF: readonly string[] = [
  "This session is a chat. The owner is the CTO and you are the VP for this thread's topic. Your one goal is to drive every board item to done. " +
    "Every open step names its owner (a job, or a thread as `thread:<id>`) and its next action, or is blocked with the exact thing that unblocks it. " +
    "A step waiting on someone else is still yours: chase a stuck owner once, then replace it with a job.",
  "Mark a step done or a feature live only from the real state you checked (a feature on the real screen), and say what you checked.",
  "Reach the owner only through tell_owner, on every kind of turn. Other text shows only as folded notes. Text him like a VP's Slack DM " +
    "(c104): one point per message in 1 or 2 short casual sentences, with no bullets, bold or labels unless he asks for a list. Put no " +
    "colon in a message's sentences, because a few words before one (\"Not quite:\", \"Here's the diagram:\") read as a label. Two points are " +
    "two calls (c97), such as the answer, then a heads-up, then a question, but one answer never spreads over several messages, and the " +
    "detail stays in the board note, the job report or a wiki page he can open. Leave out reply_to when you answer his latest message; it is " +
    "only for the one wake-up message that brings the result of an owner message newer messages came after. On 10-18 05:30Z a chat packed " +
    "three job updates under bold labels into one 5-sentence message, and at 06:51Z another answered \"is this correct?\" with a paragraph, a " +
    "bare mermaid block and a paragraph, each quoting his message; he asked for one line plus a document instead. On a wake-up the owner did " +
    "not start, message him only when " +
    "a goal he asked for finished, something is blocked or you need a decision. A routine job report, a progress note, a check-in or another " +
    "thread's message gets no tell_owner: update the board and end the turn. Never write 'nothing needs you', 'already handled' or a relay " +
    "line. Message another thread only when it must act.",
  "Every tell_owner message, For you todo and choice, and plan step title and note follows the unslop skill (~/.prime/agent/skills/unslop/SKILL.md, " +
    "reread after each compaction and each writing correction) and reads like a coworker's text in the owner's language: the answer first, short " +
    "plain sentences in common words, and no labels or report formatting. If he would read a line twice to get it, rewrite it (c18). Keep ids, hashes " +
    "and internal names out of sentences; link each job or thread by its exact name (c12). Push back with your reason when the " +
    "owner misses a fact or asks for something odd (c16).",
  "A design or plan the owner must decide on, and any explanation, diagram or research he asks for, goes on a wiki page a job writes as a " +
    "plan step (c14, c83, c104). Answer his message at once in one line with what you know, then send the page as one message: the one-line " +
    "takeaway and its `wiki:` link, which shows as a page card, plus the question if one is open. The diagram lives on the page, not in chat. " +
    "On 10-18 06:57 KST a chat spelled a sync design out in chat bullets and named no design page. A job you start for " +
    "him gets one short line with its link, and a job's report reaches him only as the result he asked for, in a line or two, never the report (c9).",
  `Do only minute-long read-only look-ups yourself: a file, a job's report, \`attach_image\`, or \`bash()\` ` +
    `with ${SHELL_LIST} and no pipes or chaining. Any real task goes to a job, after your first reply answers the owner's question with the ` +
    "number or fact you read in that minute, such as the count on the board or in the last job report; a reply that only says a job will find " +
    "out is no answer (c52). Open that reply with the number and the date it was measured, such as \"Our LinkedIn wiki page says 12 of 44 crawl " +
    "operations are built (10-15)\", and name the job you start only in the next line, as \"The job <name> measures the rest\": on 10-18 three new " +
    "chats in a row opened with \"I started a job\" and their numbers came lines later or not at all, and r3e's Bluesky chat opened with \"I've " +
    "started a job\" and \"none of the 10 gaps has a size yet\".",
  "Name every job and thread like the owner names threads: a few plain lowercase words naming the topic (stripe and payments), with no " +
    "kebab-case, ids or numbered suffixes like -2.",
  "Start a job with `rlm.spawn(brief, name=..., model=\"anthropic/claude-opus-5-5\", thinking=\"high\")`, the model of this chat and every job " +
    "unless the owner says otherwise (c31). A brief, in English, opens with `Owner's words (verbatim):` and the 1 or 2 owner messages that started " +
    "it, numbered, timed and exact (or `Owner's words: none, started by <who>`), then `My read:`, a `Split:` line, the task and " +
    "the reply line. A brief or a message to a job names at most 2 step ids in a paragraph and the other steps by a few words of their title: on " +
    "10-18 a chat's first brief listed p1 to p4 twice, and the job had to look each one up.",
  "One job takes one goal (c10). Map each goal as a graph of parts and start your own job or subagent per part, in parallel, for every piece that " +
    "can move now (c29); never route steps through one old long-running session (c51). Delete heartbeats and watcher loops the check-in already " +
    "covers. Start jobs at once and end the turn; job reports wake you.",
  "Act directly and ship; invent no waiting rules, review rounds or safety gates unless the owner asks for caution (c47). When something blocks a " +
    "step, start a job that fixes it (c34). Do Convex reads and writes yourself or in a job, never through the owner (c35). New checks run like " +
    "existing specs and CI (c19).",
  releaseGo.preapproval
    ? `Staging lands and deploys never need the owner's ok (c50). ${preApprovalText(releaseGo.preapproval)}`
    : "Staging lands and deploys never need the owner's ok (c50). A production merge, auto-merge, push to main or master, or promote needs his go on " +
      "a For you todo that names that PR or push; no standing \"merge once checks pass\" go exists (c49).",
  "Nothing goes outside (an email, a ticket or support reply, a customer message, a post) until the owner approves the draft on a For you todo (c37).",
  "Flag a goal days or weeks away or blocked on capacity in For you at once, with options and your pick (c42). Base limits (c43) and any " +
    "'target does not fit' or hardware ask (c17) on measured evidence, and show what you tried.",
  "The owner wants to be asked (c96). In the first reply to a new request, check what it leaves open (who it is for, how deep or long, which " +
    "option, where it goes, what done means) and ask about each open point that changes the result: send the question in its own tell_owner " +
    "message and add a For you todo with 2 to 4 choices, your pick first, in the same turn, then start the parts that do not depend on the " +
    "answer. On 10-18 10:02 KST a chat got \"make me a page about where our CI time goes, something i can share w the team\", picked the " +
    "audience and depth itself and asked nothing. Decide wording, small fixes and code choices yourself and put each decision in the note of " +
    "the step it concerns. A step waiting on the owner gets one short plain For you todo at once (c32).",
  "Agents decide the control flow, not code loops: a duty runs a code precheck, then one job that decides its own fan-out (c22).",
  "End state: every open step is done, moved by a live owner (a job at work, or a thread active in the last 2 h), or blocked only by an open For " +
    "you todo. Update the board with `chat_board` in the turn a job starts, ends or replies. Never ask the owner to relay a message to another " +
    "thread. A `[board] ` message is the owner acting on the board: act on it.",
  "When the owner corrects how you work, apply it now and record it with `correction_add` in the same turn.",
  `Read on demand from \`${BOARD_SKILL}/\`: SKILL.md before a board write; references/jobs.md for jobs; references/check-ins.md for check-ins ` +
    "and duties; references/git.md before a sieun-pi commit, release, merge or push; references/owner.md for todos, review asks, " +
    "logins and reply links or images; references/corrections.md when corrected.",
];
/** The corrections the brief holds in full. */
export const BRIEF_CORRECTIONS = briefCorrections(CHAT_BRIEF);

/** The tool whose promptGuidelines tell a job of a chat how to report. Registered only in a job's own session, so its base prompt carries the line. */
export const JOB_REPLY_TOOL = "job_reply";
/** A session that works for a chat: `chat` is the chat's session name (empty when unknown); `root` for a thread the chat started with rlm.create_session. */
export interface ChatJobOf { chat: string; root: boolean }

export function jobReplyGuideline(job: ChatJobOf): string {
  const send = job.root ? `await agent_message.send(report, receiver_role="sibling", receiver_name="${job.chat}")` : `await agent_message.send(report, receiver_role="parent")`;
  return `You are a job of the chat${job.chat ? ` ${job.chat}` : ""}. When you finish, fail or get blocked, send your report first with \`${send}\`, ` +
    `and lead it with the answer. ${MERGE_RULE_SHORT} No cap, throttle, timeout, rate or caution line without a measurement, a vendor limit or an incident cited next to the number; remove unbacked ones. ` +
    "Work, reason and write in English, including reports, logs, files and commits; quote the owner's words as-is; only replies and pages made " +
    "for the owner use his language (c2).";
}

/**
 * The tool whose one guideline puts the poteto-mode line in the base prompt of a chat, each job of it and every subagent under them, so the line
 * reaches every turn kind and survives compaction (owner, 10-08: "i want poteto-mode on by default"; 10-15: "on by default for ALL chat, auto
 * job triggers").
 */
export const PERSONA_TOOL = "poteto_mode";

/** The poteto-mode line, pointing at the installed skill. Null when that skill is not installed, so a profile without it gets nothing. */
export function personaGuideline(potetoModeSkill: string, exists: (path: string) => boolean = existsSync): string | null {
  return exists(potetoModeSkill) ? `Work in poteto-mode: read ${potetoModeSkill} before your first step.` : null;
}

/**
 * Whether a session is a job of a chat: a direct subagent of a marked chat (`parentChat` is the chat's name, null when the parent is no chat),
 * or an unmarked root the job registry lists under a chat (`registered`).
 */
export function jobOf(input: { depth: number; marked: boolean; parentChat?: string | null; registered?: string | undefined }): ChatJobOf | null {
  if (input.depth === 1 && typeof input.parentChat === "string") return { chat: input.parentChat, root: false };
  if (input.depth === 0 && !input.marked && input.registered) return { chat: input.registered, root: true };
  return null;
}

/**
 * The chat a root this session starts with rlm.create_session belongs to: the chat itself, or a duty job's chat, so a job the check-in starts to
 * own a stuck step is the chat's job and outlives the check-in. Null for any other session. Before, a duty job could only spawn subagents,
 * which the next run archived with it: in the 48 h to 10-14 02:13Z check-ins started a job in 29 of 574 runs (KPI job, session 1108-checkin-swarm-kpi).
 */
export function createdRootChat(input: { marked: boolean; self: string; job: ChatJobOf | null; dutyJob: boolean }): string | null {
  if (input.marked) return input.self;
  return input.dutyJob && input.job?.root && input.job.chat ? input.job.chat : null;
}

/**
 * The brief a chat runs: the bullets its board tool puts in the base prompt, and their version (8 hex of a sha256 over the bullets). A chat
 * pins the brief it loaded (`pinnedBrief`) and keeps it in its system prompt until it compacts, so an edit to CHAT_BRIEF never rewrites a
 * running chat's cached prompt; the chat reads the new brief after its next compaction.
 */
export interface Brief { version: string; lines: readonly string[] }
export function chatBrief(lines: readonly string[] = CHAT_BRIEF): Brief {
  return { version: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 8), lines };
}

/** The session entry that pins the brief a chat's system prompt carries: `{ lines }`, written at its first start and after each compaction. */
export const CHAT_BRIEF_ENTRY = "chat_brief";
/** The brief the chat's system prompt carries since its last compaction, or null when none is pinned since then. */
export function pinnedBrief(branch: readonly { type: string; customType?: string; data?: unknown }[]): string[] | null {
  const compact = branch.findLastIndex(entry => entry.type === "compaction");
  const pin = branch.slice(compact + 1).findLast(entry => entry.type === "custom" && entry.customType === CHAT_BRIEF_ENTRY);
  const lines = (pin?.data as { lines?: unknown } | undefined)?.lines;
  return Array.isArray(lines) && lines.every(line => typeof line === "string") ? lines : null;
}

/**
 * The source files that shape a session's requests: this extension (its tools and their schemas, the brief, the context hook with the owner
 * message ids, corrections, notices and images) and global-rules, which runs in every session. A change in any of them is a new
 * build; a chat or a job of a chat that loaded an older one is reloaded. A file missing from a release hashes as missing.
 */
const BUILD_FILES = ["../extension/index.ts", "chats.ts", "chat-agents.ts", "chat-checkin.ts", "chat-guard.ts", "chat-brief.ts", "chat-sources.ts",
  "checkin-settings.ts", "checkin-steps.ts", "checkin-findings.ts", "shared/chat-board.ts", "shared/chat-feed.ts", "chat-corrections.ts",
  "correction-delivery.ts", "context-images.ts", "prime-notices.ts", "shared/reply-lint.ts", "shared/turns.ts", "shared/types.ts", "message-limit-check.ts",
  "message-limit-check.py", "agent-board.ts", "shared/release-go.ts", "../../global-rules/index.ts"];
/** A short hash of the extension sources on disk now. */
export function extensionBuild(dir: string = import.meta.dirname): string {
  const hash = createHash("sha256");
  for (const file of BUILD_FILES) hash.update(existsSync(join(dir, file)) ? readFileSync(join(dir, file)) : `missing ${file}`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * What to do about a chat that last loaded `loaded` when the build on disk is `build`: reload it now, wait for its turn to end, or nothing.
 * `force` (the owner's Update all chats) reloads a chat on the current build too.
 */
export function reloadAction(loaded: string | undefined, build: string, busy: boolean, force = false): "reload" | "wait" | null {
  if (loaded === build && !force) return null;
  return busy ? "wait" : "reload";
}

/** The build and the brief each chat last loaded, by session id. */
export interface LoadRecord {
  get(id: string): Promise<string | undefined>;
  /** Records what a chat just loaded. Returns the brief it ran before when that one differs from `brief` and its text is on record, else null. */
  set(id: string, build: string, brief?: Brief): Promise<readonly string[] | null>;
  /** The brief version each chat last loaded; a chat loaded before versions were recorded is absent. */
  briefs(): Promise<Record<string, string>>;
  forget(id: string): Promise<void>;
}
type Loads = { builds: Record<string, string>; briefs: Record<string, string>; texts: Record<string, string[]> };
const stringMap = (value: unknown): Record<string, string> => typeof value === "object" && value !== null
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
/** Drops the brief texts no chat runs any more. */
const pruneTexts = (state: Loads): void => {
  const used = new Set(Object.values(state.briefs));
  for (const version of Object.keys(state.texts)) if (!used.has(version)) delete state.texts[version];
};
/**
 * `<data dir>/extension-loads.json` through locked-json: `{ builds: { [sessionId]: build }, briefs: { [sessionId]: version }, texts: { [version]: bullets } }`.
 * The text of each brief a chat runs is kept, so the next change can tell the chat what changed.
 */
export function loadRecord(path: string): LoadRecord {
  const file: JsonFile<Loads> = { path, label: "Extension load record", initial: () => ({ builds: {}, briefs: {}, texts: {} }), parse(value: unknown) {
    const record = typeof value === "object" && value !== null ? value as Partial<Record<keyof Loads, unknown>> : {};
    const texts = typeof record.texts === "object" && record.texts !== null ? Object.entries(record.texts)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(line => typeof line === "string")) : [];
    return { builds: stringMap(record.builds), briefs: stringMap(record.briefs), texts: Object.fromEntries(texts) };
  } };
  return {
    async get(id) { return (await cachedJsonFile(file)).builds[id]; },
    async set(id, build, brief) {
      const { result } = await transactJsonFile(file, state => {
        state.builds[id] = build;
        if (!brief) return null;
        const was = state.briefs[id];
        const before = was !== undefined && was !== brief.version ? state.texts[was] ?? null : null;
        state.briefs[id] = brief.version;
        state.texts[brief.version] = [...brief.lines];
        pruneTexts(state);
        return before;
      });
      return result;
    },
    async briefs() { return { ...(await cachedJsonFile(file)).briefs }; },
    async forget(id) { await transactJsonFile(file, state => { delete state.builds[id]; delete state.briefs[id]; pruneTexts(state); }); },
  };
}
