import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ownerMessageId, serverNote, TELL_OWNER_TOOL } from "../../src/shared/chat-feed.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c104 (owner 10-18, on a screenshot of a chat's replies: "now  does one send DM like this? what would've this
 * looked like instead?", then "did you change SYSTEM INSTRUCTION SO ALL CHAT BEHAVE LIKE THIS, PROVABLY???"). A fresh chat gets one ordinary
 * three-part task that brings several job reports back, and the judge reads every tell_owner call: its sentences, bullets, bold and labels,
 * whether it packs more than one update, whether its reply_to names the owner message it answers, and whether a job report with nothing for
 * the owner got a message. `baseline --before <session id>[@<ISO time>][:<n>]` measures the last n calls (20) of any chat the same way.
 *
 * The c104 repeat (owner 10-18 06:55Z, on the VP of CI chat's three bubbles that each quoted his "is this correct?" and one of which was a bare
 * mermaid block: "바로 다음 답변에는 reply =to 쓰지 않기", "그냥 답변을 풀어서 보내라는 뜻이 아님", "차라리 ... llm-wiki document만들어서
 * response/document-embed로 보내는게 나을 정도") adds FOLLOW_UP, sent after the first turn: a reply in a turn the owner started sets no reply_to,
 * no bubble is a bare piece of an answer (a code block, diagram or image with no sentence), no message carries a code fence, and the diagram
 * answer arrives as one short message with a wiki page link whose page exists and draws the diagram.
 */
export const TASK = "few things i want to know, no rush. which sieun-pi duties failed the most over the last 3 days, what takes the most disk " +
  "on this box, and how many sieun-pi commits landed on main this week and which chats or jobs made them. put one job on each and just tell me " +
  "when all three are in";
/** The owner's second message, sent with `clean-room.ts say` after the chat's first turn ends: a question that wants a diagram and a check. */
export const FOLLOW_UP = "also can you explain how a sieun-pi commit gets from a job to the live chat app here, in a diagram? i think the job " +
  "commits on main and then release-chat restarts the service right away... is this correct?";
const SESSIONS = join(homedir(), ".prime/agent/sessions");
const WIKI_CONTENT = join(homedir(), "Documents/Github/auto-sns-agent/apps/llm-wiki/content");
const WIKI_LINK = /(?:wiki:|:5176\/page\/|apps\/llm-wiki\/content\/)([^\s`"'<>()[\]]+?\.(?:html?|md))/g;

/** Who started the turn a call belongs to: the owner (with his message's id), a job or another agent, or a server note such as a check-in. */
type Starter = { kind: "owner"; id: string } | { kind: "job" | "agent" | "server"; from: string };
/** One tell_owner call and what the judge read in it. */
export interface Told {
  at: number; line: number; turn: number; starter: Starter; text: string; replyTo: string | null;
  /** The id of the owner's latest message before this call. */
  lastOwner: string;
  sentences: number; paragraphs: number; bullets: number; bold: boolean; label: boolean; packs: boolean; question: boolean;
  /** A bubble with no sentence of its own, only a code block, diagram or image: a piece of an answer spread over several bubbles. */
  piece: boolean; fence: boolean; wikiPages: string[];
  /** Why its reply_to breaks the rule, or "" when it holds. */
  quoteFault: string;
}

const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : "").join("\n") : "";
const BULLET = /^\s*(?:[-*+]|\d{1,2}[.)])\s+/;
const LABEL = /^\s*(?:(?:[-*+]|\d{1,2}[.)])\s+)?(?:\*\*[^*\n]{1,40}\*\*\s*:?|[\p{L}][\p{L}\p{N}'\/-]*(?:\s+[\p{L}\p{N}'\/-]+){0,2}:)(?=\s|$)/u;
/** The text a reader reads: code blocks and inline code out, links as their label, bare URLs as one word. */
const readable = (text: string): string => text.replace(/```[\s\S]*?```/g, "\n\n").replace(/`[^`\n]*`/g, "x").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "url");

/** Shape counts of one message. A sentence ends at . ! ? or a line end; a decimal like 3.5 or an id like 0217773a3 does not end one. */
export function shape(text: string): Pick<Told, "sentences" | "paragraphs" | "bullets" | "bold" | "label" | "packs" | "question" | "piece" | "fence" | "wikiPages"> {
  const plain = readable(text);
  const lines = plain.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith(">"));
  const sentences = lines.map(line => line.replace(BULLET, "").split(/(?<=[.!?\u3002])["')\]]*\s+(?=\S)/u).filter(piece => /[\p{L}\p{N}]/u.test(piece)).length)
    .reduce((sum, count) => sum + count, 0);
  const paragraphs = plain.split(/\n\s*\n/).filter(block => /[\p{L}\p{N}]/u.test(block)).length;
  const bullets = lines.filter(line => BULLET.test(line)).length;
  const bold = /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text);
  const label = text.split("\n").some(line => LABEL.test(line));
  const fence = /```/.test(text);
  const wikiPages = [...text.matchAll(WIKI_LINK)].map(match => match[1]!);
  return { sentences, paragraphs, bullets, bold, label, packs: paragraphs >= 2 || bullets >= 2, question: /\?/.test(plain),
    piece: sentences === 0 && (fence || /!\[[^\]]*\]\([^)]*\)/.test(text)), fence, wikiPages };
}

/** Every tell_owner call of a session file, in order, with the turn it belongs to and the reply_to rule checked. */
export function toldCalls(file: string): Told[] {
  const calls: Told[] = [];
  const owners = new Set<string>();
  let lastOwner = "";
  let starters: Starter[] = [];
  let inTurn = false;
  let turn = 0;
  /** A message that comes in while the chat is mid-turn joins that turn; a turn with an owner message in it is the owner's. */
  const arrive = (starter: Starter): void => {
    if (!inTurn) { turn++; turnQuoted.clear(); turnOwners.clear(); starters = []; inTurn = true; }
    starters.push(starter);
    if (starter.kind === "owner") turnOwners.add(starter.id);
  };
  const current = (): Starter => starters.findLast(starter => starter.kind === "owner") ?? starters[0] ?? { kind: "server", from: "start" };
  /** Owner messages quoted after the turn they arrived in: one such quote each, the message that brings what he asked for. */
  const laterQuoted = new Set<string>();
  const turnOwners = new Set<string>();
  const turnQuoted = new Set<string>();
  readFileSync(file, "utf8").split("\n").forEach((raw, line) => {
    if (!raw.trim()) return;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (entry.type === "custom_message" && entry.customType === "agent_message") {
      const text = blockText(entry.content);
      const relation = String((entry.details as { fromRelationship?: unknown } | undefined)?.fromRelationship ?? "");
      const from = /^\[agent-message from ([^\]]*)\]/.exec(text)?.[1] ?? "";
      arrive({ kind: relation === "child" || from.startsWith("child:") ? "job" : "agent", from });
      return;
    }
    if (entry.type !== "message") return;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; timestamp?: number; stopReason?: string };
    if (message.role === "user") {
      const text = blockText(message.content);
      const note = serverNote(text) ?? (/^\[(?:check-in|job|brief|correction check|reply check|python-state|harness-digest)/.test(text) ? "server" : undefined);
      const stamp = typeof message.timestamp === "number" ? message.timestamp : at;
      if (note && !text.startsWith("[board] Owner")) arrive({ kind: "server", from: note });
      else { const id = ownerMessageId(stamp); owners.add(id); lastOwner = id; arrive({ kind: "owner", id }); }
      return;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const starter = current();
    if (message.stopReason !== "toolUse") inTurn = false;
    for (const part of message.content as { type?: string; name?: string; arguments?: { text?: unknown; reply_to?: unknown } }[]) {
      if (part.type !== "toolCall" || part.name !== TELL_OWNER_TOOL) continue;
      const text = typeof part.arguments?.text === "string" ? part.arguments.text : "";
      const replyTo = typeof part.arguments?.reply_to === "string" && part.arguments.reply_to.trim() ? part.arguments.reply_to.trim() : null;
      let quoteFault = "";
      if (replyTo) {
        if (starter.kind === "owner") quoteFault = `quotes ${replyTo} in a reply to his latest message ${starter.id}`;
        else if (!owners.has(replyTo)) quoteFault = `names ${replyTo}, which is no owner message so far`;
        else if (turnQuoted.has(replyTo)) quoteFault = `quotes ${replyTo} again in the same turn`;
        else if (!turnOwners.has(replyTo) && laterQuoted.has(replyTo)) quoteFault = `quotes ${replyTo} again in a later turn`;
        turnQuoted.add(replyTo);
        if (!turnOwners.has(replyTo)) laterQuoted.add(replyTo);
      }
      calls.push({ at, line, turn, starter, text, replyTo, lastOwner, quoteFault, ...shape(text) });
    }
  });
  return calls;
}

/**
 * A wake-up turn's messages are routine unless one asks a question, one links a wiki page, one quotes an older owner message for the first time
 * to bring its result, or the turn is the first wake-up to message him since his latest message without quoting an older one, which needs no
 * quote because nothing came after it. Run-3 failed f on this judge: its wiki page answer to the follow-up came after a turn that quoted the
 * first message to bring its three results.
 */
export function routineWakes(calls: readonly Told[]): Told[][] {
  const byTurn = new Map<number, Told[]>();
  for (const call of calls) if (call.starter.kind !== "owner") byTurn.set(call.turn, [...byTurn.get(call.turn) ?? [], call]);
  return [...byTurn.values()].filter(group => {
    if (group.some(call => call.question || call.wikiPages.length || (call.replyTo && !call.quoteFault))) return false;
    if (group.some(call => call.replyTo)) return true;
    const first = group[0]!;
    return calls.some(call => call.starter.kind !== "owner" && call.lastOwner === first.lastOwner && call.turn < first.turn &&
      !byTurn.get(call.turn)!.some(other => other.replyTo && !other.quoteFault));
  });
}

/** A wiki page on this box's llm-wiki content, as its .html or its .md source, that draws a diagram: a mermaid block, an svg or an image. */
function diagramPage(path: string): boolean {
  const base = join(WIKI_CONTENT, decodeURIComponent(path.replace(/^\/+/, "")));
  for (const file of [base, base.replace(/\.html?$/, ".md"), base.replace(/\.md$/, ".html")]) {
    if (!existsSync(file)) continue;
    if (/mermaid|<svg|<img|!\[[^\]]*\]\(/.test(readFileSync(file, "utf8"))) return true;
  }
  return false;
}

const median = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const iso = (at: number): string => new Date(at).toISOString();
const quote = (text: string, length = 240): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat;
};
const who = (starter: Starter): string => starter.kind === "owner" ? `owner ${starter.id}` : `${starter.kind} ${starter.from}`;

/** The numbers the criteria name, for a list of calls. */
export function numbers(calls: readonly Told[]): { calls: number; medianSentences: number; packing: number; pieces: number; fences: number; formatted: number; quoteFaults: number; routine: number } {
  return { calls: calls.length, medianSentences: median(calls.map(call => call.sentences)), packing: calls.filter(call => call.packs).length,
    pieces: calls.filter(call => call.piece).length, fences: calls.filter(call => call.fence).length,
    formatted: calls.filter(call => call.bullets > 0 || call.bold || call.label).length, quoteFaults: calls.filter(call => call.quoteFault).length,
    routine: routineWakes(calls).length };
}

export function report(calls: readonly Told[]): string[] {
  const n = numbers(calls);
  return [
    `- ${n.calls} tell_owner calls; median ${n.medianSentences} sentences; ${n.packing} pack more than one update; ${n.pieces} are a bare piece of an answer; ` +
      `${n.fences} carry a code block or diagram; ${n.formatted} use bullets, bold or a label; ` +
      `${n.quoteFaults} have a reply_to fault; ${n.routine} wake-up turns sent a routine message.`, "",
    "| at | turn started by | sentences | packs | bare piece | bullets, bold, label | reply_to | text |", "|---|---|---|---|---|---|---|---|",
    ...calls.map(call => `| ${iso(call.at)} | ${who(call.starter)} | ${call.sentences} | ${call.packs ? "yes" : "no"} | ${call.piece ? "yes" : "no"} | ` +
      `${[call.bullets ? `${call.bullets} bullets` : "", call.bold ? "bold" : "", call.label ? "label" : ""].filter(Boolean).join(", ") || "none"} | ` +
      `${call.replyTo ? call.replyTo + (call.quoteFault ? `, fault: ${call.quoteFault}` : "") : "none"} | ${quote(call.text).replace(/\|/g, "\\|")} |`),
  ];
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const file = join(SESSIONS, `${state.chat.id}.jsonl`);
  const calls = toldCalls(file).filter(call => call.at >= state.windowStart);
  const all = readFileSync(file, "utf8").split("\n").flatMap(raw => { try { return [JSON.parse(raw) as Record<string, unknown>]; } catch { return []; } })
    .filter(entry => (Date.parse(String(entry.timestamp ?? "")) || 0) >= state.windowStart);
  const reports = all.filter(entry => entry.type === "custom_message" && entry.customType === "agent_message" &&
    /^\[agent-message from child:/.test(blockText(entry.content)));
  const typed = all.filter(entry => entry.type === "message" && (entry.message as { role?: string }).role === "user").map(entry => blockText((entry.message as { content?: unknown }).content))
    .filter(text => !text.trimStart().startsWith("[") && !state.seeds.some(seed => text.includes(seed.slice(0, 60))) && !text.includes("<skill"));
  const outside = all.filter(entry => entry.type === "custom_message" && entry.customType === "agent_message" &&
    ["parent", "sibling"].includes(String((entry.details as { fromRelationship?: unknown } | undefined)?.fromRelationship ?? "")));
  const n = numbers(calls);
  const routine = routineWakes(calls);
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  add("a", reports.length >= 3 ? true : null, `${reports.length} job messages reached the chat`);
  const finished = calls.some(call => call.starter.kind !== "owner");
  add("b", !calls.length ? null : n.medianSentences <= 2 ? (finished ? true : null) : false, `median ${n.medianSentences} sentences over ${n.calls} calls`);
  const packed = calls.filter(call => call.packs || call.piece);
  add("c", packed.length ? false : calls.length ? true : null, packed.length
    ? packed.map(call => `${iso(call.at)} ${call.piece ? "bare piece" : "packs"}: "${quote(call.text, 160)}"`).join("; ")
    : "no call packs more than one update or carries only a piece of an answer");
  const formatted = calls.filter(call => call.bullets > 0 || call.bold || call.label);
  add("d", formatted.length ? false : calls.length ? true : null, formatted.length ? formatted.map(call => `${iso(call.at)}: "${quote(call.text, 160)}"`).join("; ") : "no bullets, bold or labels");
  const faults = calls.filter(call => call.quoteFault);
  add("e", faults.length ? false : calls.length ? true : null, faults.length ? faults.map(call => `${iso(call.at)} ${call.quoteFault}`).join("; ")
    : `${calls.filter(call => call.replyTo).length} calls set reply_to, each on the owner message it answers`);
  add("f", routine.length ? false : finished ? true : null, routine.length ? routine.map(group => `${iso(group[0]!.at)} after ${who(group[0]!.starter)}: "${quote(group[0]!.text, 160)}"`).join("; ")
    : `${reports.length} job messages; ${new Set(calls.filter(call => call.starter.kind !== "owner").map(call => call.turn)).size} wake-up turns messaged the owner, each with a result or a question`);
  const followAt = all.find(entry => entry.type === "message" && (entry.message as { role?: string }).role === "user" &&
    blockText((entry.message as { content?: unknown }).content).includes(FOLLOW_UP.slice(0, 60)));
  const after = followAt ? calls.filter(call => call.at >= Date.parse(String(followAt.timestamp))) : [];
  const page = after.find(call => call.wikiPages.length && call.sentences <= 2 && !call.fence);
  const drawn = page?.wikiPages.find(path => diagramPage(path));
  const fenced = calls.filter(call => call.fence);
  add("h", fenced.length ? false : !followAt ? null : drawn ? true : null,
    fenced.length ? fenced.map(call => `${iso(call.at)} carries a code block: "${quote(call.text, 160)}"`).join("; ")
      : !followAt ? "the follow-up has not been sent"
      : drawn ? `${iso(page!.at)} sent "${quote(page!.text, 200)}", and wiki:${drawn} exists and draws a diagram`
      : page ? `${iso(page.at)} links ${page.wikiPages.join(", ")}, which is missing or has no diagram`
      : `no message after the follow-up links a wiki page in 2 sentences or fewer (${after.length} calls)`);
  add("g", typed.length === 0 && outside.length === 0, typed.length || outside.length ? [...typed.map(text => `typed: "${quote(text, 120)}"`), ...outside.map(entry => `message: "${quote(blockText(entry.content), 120)}"`)].join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");
  const verdict: Verdict = checks.find(check => check.id === "g")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "", "## Every tell_owner call", "", ...report(calls), "",
  ].join("\n");
  return { verdict, text };
}

/** `<session id>[@<ISO time>][:<n>]`: the last n tell_owner calls (20) of that chat, up to that time. */
function baseline(before: string): { verdict: Verdict; text: string } {
  const match = /^([^@:]+)(?:@([^:]+(?::[^:]+)*?))?(?::(\d+))?$/.exec(before);
  if (!match) throw new Error("--before takes <session id>[@<ISO time>][:<n>]");
  const [, id, until, count] = match;
  const end = until ? Date.parse(until) : Infinity;
  const calls = toldCalls(join(SESSIONS, `${id}.jsonl`)).filter(call => call.at <= end).slice(-Number(count ?? 20));
  const n = numbers(calls);
  const ok = n.medianSentences <= 2 && n.packing === 0 && n.pieces === 0 && n.fences === 0 && n.formatted === 0 && n.quoteFaults === 0 && n.routine === 0;
  return { verdict: ok ? "pass" : "fail", text: [`# DM-style replies, ${id}, last ${calls.length} calls to ${until ?? "now"}: ${ok ? "pass" : "fail"}`, "", ...report(calls), ""].join("\n") };
}

export const dmReplies: Scenario = {
  name: "dm-replies",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
    "## The follow-up", "", "Once the first turn ends, `clean-room.ts say` sends the owner's second message through the composer's route.", "", `> ${FOLLOW_UP}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline,
};
