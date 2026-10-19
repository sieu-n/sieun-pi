import { FENCE, serverNote } from "./chat-feed.ts";
import { messageText } from "./turns.ts";
import type { BoardOp, ThreadMessage } from "./types.ts";

/**
 * The board text checks: internal terms in a For you todo (c32, owner 10-09: "unslop easy word") and a limit with a rate or size and no
 * evidence in its own sentence, in a todo or a plan step (c43, owner 10-12: "what is the bottleneck actual IOPS? CPU? RAM??????", "r u fucking
 * kidding?"). Length and form of a reply to the owner stay brief rules (c81, c97; owner 10-18: "also is this a hard cap (code-level) or
 * something? if so strip all these"); only the shop talk below gets a check, a soft one (`shopTalk`).
 */

/**
 * An internal name the owner should not have to decode in a todo: regex sources matched as whole Latin words (a Korean particle may follow, as
 * in "duty가"), and Korean stems matched at a word start, any ending. `keep` spares one use by what is around it.
 */
interface WordRule { en?: readonly string[]; ko?: readonly string[]; keep?: (before: string) => boolean }
/** A product's own term, named by the capitalized word or the link or code span before it (Claude Code hooks, Cal.com hooks). */
const properNamed = (before: string): boolean => /(?:\p{Lu}[\p{L}\p{N}.]*|\u00a7)\s*$/u.test(before);

const WORD_RULES: readonly WordRule[] = [
  { en: ["duty", "duties"], ko: ["듀티"] },
  { en: ["built[- ]?in"], ko: ["기본으로 들어가", "기본 탑재", "내장"] },
  { en: ["pre-?checks?"], ko: ["프리체크"] },
  { en: ["digests?"], ko: ["다이제스트"] },
  { en: ["steer", "steers", "steered", "steering"], ko: ["스티어"] },
  { en: ["check-?in jobs?", "act class(?:es)?", "step class(?:es)?"] },
  { en: ["board (?:upkeep|convergence|maintenance)"], ko: ["보드 관리", "보드 정리"] },
  { en: ["fan[- ]?outs?", "fans out", "fanned out", "fanning out"], ko: ["팬아웃"] },
  { en: ["hooks?"], ko: ["훅"], keep: properNamed },
  { en: ["extensions?"], ko: ["익스텐션"], keep: properNamed },
  { en: ["catalog(?:ue)?s?"], ko: ["카탈로그"], keep: properNamed },
  { en: ["memos?"], ko: ["메모"] },
  { en: ["stale-chase", "orphans?", "foryou"] },
  { en: ["probe slots?", "land flows?", "key locks?"] },
];
const ruleRegex = (rule: WordRule): RegExp => new RegExp([
  ...(rule.en?.length ? [`(?<![\\p{Script=Latin}\\p{N}_-])(?:${rule.en.join("|")})(?![\\p{Script=Latin}\\p{N}_-])`] : []),
  ...(rule.ko?.length ? [`(?<![\\p{L}\\p{N}])(?:${rule.ko.join("|")})`] : []),
].join("|"), "giu");
const RULE_REGEX = new Map(WORD_RULES.map(rule => [rule, ruleRegex(rule)]));

export const JARGON_HINT = "these are our internal names; say what it does for the owner in plain words";
const UNMEASURED_HINT = "in the same sentence, name the resource you measured and how full it was (disk 95% busy, CPU 400%, p99 latency 40 ms, 429s on " +
  "40% of calls), the vendor limit or the incident behind the number; a caution line nobody measured is no limit, so drop it and say you dropped it (c43)";

/**
 * A capacity claim (c43): a cap, ceiling, limit, max, bottleneck or ban word with a rate or size in the same sentence ("caps new profiles near
 * 2,200 a minute", "50 pages per account before a ban"). A count with no rate ("at most 6 open goals") is a rule, not a capacity claim.
 */
const CAP_WORD = new RegExp([
  "(?<!all[- ])\\bcap(?:s|ped|ping)?\\b", "\\bceilings?\\b", "\\blimit(?:s|ed|ing)?\\b", "(?<!\\p{Lu}\\p{L}*\\s)\\bmax(?:imum|es|ed)?\\b",
  "\\bbottleneck(?:s|ed)?\\b", "\\btops? out\\b", "\\bonly fits?\\b", "\\b(?:can't|cannot|can not|won't) (?:carry|handle|fit|keep up|go past|exceed)\\b",
  "\\b(?:can|could) only\\b", "\\b(?:go|goes|handles?|takes?|carry|carries|reach(?:es)?|serves?|supports?)\\s+up to\\s+(?:about\\s+|~)?\\d", "\\bban risk\\b", "\\bbefore\\b(?:\\s+\\S+){0,4}\\s+bans?\\b",
  "\\bbanned (?:after|past|above|over|beyond)\\b", "최대", "한계", "상한", "병목",
].join("|"), "iu");
/**
 * A cap word that is denied or removed, not claimed: "not a real limit", "no 'metal 80/s cap'", "remove the daily wire cap", "dropped the 75 MB/s
 * line" (Crawler VP agent messages, 10-12).
 */
const NOT_CAP = /(?:\bnot|n't|\bno)\s+(?:(?:the|a|an|our|any|every|this|that|its|their|your)\s+)?(?:[\p{L}'-]+\s+){0,2}$|\b(?:drop|remov|strip|lift|wip|delet)\p{L}*\b[^,;:]*$/iu;
const PER = "second|sec|minute|min|hour|hr|day|account|profile|proxy|ip|worker|core|request|call|session";
const RATE = new RegExp([
  `\\d[\\d,.]*\\s*[kKmM]?\\s*(?:[\\p{L}]+\\s+){0,2}(?:a|an|per|each|every)\\s+(?:${PER})s?\\b`,
  "\\d[\\d,.]*\\s*[kKmM]?\\s*(?:[\\p{L}]+\\s*)?\\/\\s*(?:(?:s|sec|min|m|h|hr|hour|day|d)\\b|초|분)",
  "\\d[\\d,.]*\\s*(?:KB|MB|GB|TB|IOPS|rps|qps|rpm)\\b", "(?:분당|초당|시간당|계정당|하루)[^.\\d]{0,8}\\d",
].join("|"), "u");
/** Measured saturation of a named resource ("disk 95% busy", "CPU 400%", "p99 latency 40 ms", "429s on 40% of calls"). */
const RESOURCE = "cpu|cores?|disk|nvme|ssd|iowait|io|iops|ram|memory|mem|rss|swap|network|bandwidth|nic|gpu|database|db|postgres|clickhouse|redis|" +
  "opensearch|convex|proxy|proxies|pool|queue|connections?|디스크|메모리|램|네트워크|대역폭";
const MEASURED = new RegExp([
  `(?:\\b(?:${RESOURCE})\\b)[^.\\n]{0,40}?\\d+(?:\\.\\d+)?\\s*%`,
  `\\d+(?:\\.\\d+)?\\s*%\\s*(?:busy|utili[sz](?:ed|ation)|used|full|saturated|iowait|(?:of\\s+)?(?:the\\s+)?(?:${RESOURCE})\\b)`,
  "\\bp(?:50|90|95|99|999)\\b[^.\\n]{0,30}?\\d+(?:\\.\\d+)?\\s*(?:ms|s|sec|seconds)\\b", "\\blatency\\b[^.\\n]{0,30}?\\d+(?:\\.\\d+)?\\s*(?:ms|s|sec|seconds)\\b",
  "\\b(?:429|5\\d\\d)s?\\b[^.\\n]{0,30}?\\d+(?:\\.\\d+)?\\s*%", "\\d+(?:\\.\\d+)?\\s*%[^.\\n]{0,30}?\\b(?:429s?|5\\d\\ds?|errors?|timeouts?|failed|failures?)\\b",
  "\\d[\\d,]*\\s+(?:429s|timeouts|errors)\\b",
].join("|"), "iu");
/**
 * The sentence calls the limit a caution or safety line, or says nobody measured it. Saying so does not excuse the claim. The Crawler VP told
 * the owner "The 2,100 cap is metal's 75 MB/s disk-write line, a caution limit" and he answered "r u fucking kidding?" (c43, 10-12 22:37 KST).
 */
const CAUTION = new RegExp([
  "\\b(?:not measured|unmeasured|never measured|nobody measured|no one measured|(?:haven't|have not|didn't|did not) measure[ds]?)\\b",
  "\\b(?:caution(?:ary)?|safety|safe)\\s+(?:line|limit|cap|margin|threshold)s?\\b", "\\bto be safe\\b", "\\bover-?caution", "측정\\s*(?:안|하지\\s*않|전)", "미측정", "안전선", "주의선",
].join("|"), "iu");
const SENTENCE = /(?<=[.!?\u3002])\s+/;

/**
 * A threshold on a rate or size (c43): a comparator right before it, at most two words between ("under metal's 75 MB/s", "<75 MB/s", "above 150
 * MB/s"). A symbol is always a threshold. A word comparator counts when the sentence names a line, gate, stop, budget or the like, or gives an
 * order or condition (DIRECTIVE), so "NVMe sat under 20 MB/s all day" stays a reading. Metal box owner sent "My +15 lines for the canary: IO
 * avg300 under 5%, NVMe 15-min mean under 75 MB/s" to the Crawler VP on 10-12 04:40Z, and the Crawler VP gated census on it (board step p118
 * says "under metal's 75 MB/s step line").
 */
const CMP_WORD = "under|below|over|above|beyond|within|at most|at or below|no more than|not more than|less than|more than|exceed(?:s|ing)?";
const CMP_GAP = "(?:\\s*(?:[\\p{L}'\\u2019-]+\\s+){0,2}(?:about\\s+|~)?)";
const THRESHOLD = new RegExp(`(?:(?<sym>(?<![-=<>])[<>]=?|[\\u2264\\u2265])|\\b(?:${CMP_WORD})\\b)${CMP_GAP}(?=\\d)`, "giu");
const RATE_AT = new RegExp(`^(?:${RATE.source})`, "u");
const LINE_NOUNS = "lines?|gates?|gating|gated|thresholds?|stops?|stopping|budgets?|guards?|holds?|ceilings?|tripwires?|alarms?|alerts?";
const LINE_WORD = new RegExp(`\\b(?:${LINE_NOUNS})\\b`, "iu");
/** An order or a condition: "Add the NVMe write 15-min mean under 75 MB/s to the +15 read" (Crawler VP to the posts lane, 10-10 03:40Z). */
const DIRECTIVE = new RegExp("^[\\s\\-*+\\d.)]*(?:(?:then|so|please|and|also|now)\\s+)?(?:add|keep|hold|set|put|cap|limit|gate|stop|pause|throttle|" +
  "require|ramp|make sure|ensure|treat|watch)\\b|\\b(?:must|needs? to|has to|have to|should|unless)\\b", "iu");
/** A condition, case kept so SQL's "IF NOT EXISTS" is none: "Pause the lane if writes go over 150 MB/s". */
const CONDITION = /\b(?:[Ii]f|only if)\b/u;
/** The same threshold with any number, percents too ("IO avg300 under 5%"): a threshold is no reading, so it is cut before MEASURED looks. */
const THRESHOLD_SPAN = new RegExp(`(?:(?<![-=<>])[<>]=?|[\\u2264\\u2265]|\\b(?:${CMP_WORD})\\b)${CMP_GAP}\\d[\\d,.]*\\s*%?`, "giu");
/** A vendor limit or an incident behind the number, the other two kinds of evidence c43 names besides a measurement, or the word measured. */
const VENDOR = /\b(?:vendor|rated|datasheet|spec\s+sheet|specs?\b(?!-)|documented|docs?|quota|plan (?:limit|cap|allows|includes)|api limit|sla)\b/iu;
const INCIDENT = /\b(?:incidents?|outages?|post-?mortem|fell over|crash(?:ed|es)?|oom(?:-killed)?|went down|stalled|froze|failed with|measured|tested)\b|장애/iu;
/** The owner set the number: a business rule he chose ("The 2/day cap is the owner's number"), not a capacity claim. */
const OWNER_SET = /\b(?:the owner'?s (?:number|cap|rule|limit)|owner caps|(?:the )?owner (?:approved|chose|set|asked for))\b/iu;
/**
 * A sentence that disowns the limit it names or asks about it: "an invented 75 MB/s 'caution line'", "every unmeasured limit stripped", "are the
 * 10 MB/s ... rates measured?".
 */
const DISOWNED = /\b(?:invented|unbacked|unmeasured|arbitrary|made-up|bogus|overruled|no longer|(?:is|are|was|were)(?: already)? gone)\b|\?\s*$/iu;
const CAP_WORDS = new RegExp(CAP_WORD.source, "giu");
/**
 * A cap named as what a reading is compared with: "1438 MB (cap 4096)", "4457 MB against the 4096 cap", "21.4 of 22.5 GB used, over ops guy's 16
 * GiB cap". It states no new limit, so with a number before it, it is no claim.
 */
const CAP_REF = /(?:\b(?:against|under|over|below|above|within|vs\.?|versus|past|fits?|of)\s+(?:[\p{L}\p{N}.'\u2019-]+\s+){0,4}|\(\s*)$/iu;

/**
 * A limit named by its number ("the 75 MB/s line", "metal's 75 MB/s step line") in a sentence that says what it carries: "the 75 MB/s line
 * carries about 2,100 new/min" and "That puts the 75 MB/s line near 2,200 new/min" (census write cuts to the Crawler VP, 10-12).
 */
const NAMED = new RegExp(`(?:${RATE.source})\\s+(?:[\\p{L}'-]+\\s+){0,2}?(?:lines?|gates?|thresholds?|stops?|budgets?|ceilings?)\\b`, "giu");
const CAPACITY = /\b(?:carr(?:y|ies|ied)|allows?|holds|lets?|fits?|supports?|puts?)\b/iu;

/** Where a named limit with a capacity verb starts, or -1. */
function namedAt(sentence: string): number {
  if (!CAPACITY.test(sentence)) return -1;
  for (const named of sentence.matchAll(NAMED)) {
    const before = sentence.slice(0, named.index);
    const ref = CAP_REF.exec(before);
    if (NOT_CAP.test(before) || (ref && /\d/.test(before.slice(0, ref.index)))) continue;
    return Math.max(...[",", ";", ":", "("].map(mark => sentence.lastIndexOf(mark, named.index - 1) + 1));
  }
  return -1;
}

/** Where the first claimed cap word is in a sentence with a rate or size, or -1. */
function capAt(sentence: string): number {
  if (!RATE.test(sentence)) return -1;
  for (const cap of sentence.matchAll(CAP_WORDS)) {
    const before = sentence.slice(0, cap.index);
    if (NOT_CAP.test(before)) continue;
    const ref = CAP_REF.exec(before);
    if (ref && /\d/.test(before.slice(0, ref.index))) continue;
    return cap.index;
  }
  return -1;
}

/** Where the quote of a threshold on a rate or size starts: at most 4 words before the comparator, inside its clause. -1 when there is none. */
function thresholdAt(sentence: string): number {
  for (const match of sentence.matchAll(THRESHOLD)) {
    const after = sentence.slice(match.index + match[0].length);
    if (!RATE_AT.test(after) || NOT_CAP.test(sentence.slice(0, match.index))) continue;
    if (!match.groups?.sym && !LINE_WORD.test(sentence) && !DIRECTIVE.test(sentence) && !CONDITION.test(sentence) && !/\bcarr(?:y|ies|ied)\b/iu.test(sentence)) continue;
    const clause = Math.max(...[",", ";", ":", "("].map(mark => sentence.lastIndexOf(mark, match.index - 1) + 1));
    const words = /(?:\S+\s+){0,4}$/u.exec(sentence.slice(clause, match.index))!;
    return clause + words.index;
  }
  return -1;
}

/**
 * Each sentence that states a limit with a rate or size, as a cap or as a threshold, and does not carry its evidence itself (measured saturation,
 * a vendor limit or an incident), or calls the limit a caution line.
 */
function unmeasuredLimits(lines: readonly { words: string }[]): string[] {
  return lines.flatMap(line => line.words.split(SENTENCE)).flatMap(sentence => {
    if (DISOWNED.test(sentence)) return [];
    const cap = capAt(sentence);
    const threshold = cap >= 0 ? cap : thresholdAt(sentence);
    const at = threshold >= 0 ? threshold : namedAt(sentence);
    if (at < 0) return [];
    const evidence = MEASURED.test(sentence.replace(THRESHOLD_SPAN, " ")) || VENDOR.test(sentence) || INCIDENT.test(sentence) || OWNER_SET.test(sentence);
    if (evidence && !CAUTION.test(sentence)) return [];
    return [clipQuote(sentence.slice(at).replace(/\s*\u00a7\s*/g, " ").trim(), 60)];
  });
}

/**
 * The text with each job name that holds a cap word cut out: the Crawler VP's job "instagram 401 ceiling" is a name, not a ceiling. `names` are
 * the job names the chats know (src/limit-names.ts).
 */
function withoutNames(text: string, names: readonly string[]): string {
  const capped = names.filter(name => CAP_WORD.test(name)).sort((a, b) => b.length - a.length);
  if (!capped.length) return text;
  const escaped = capped.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu"), "the job");
}

/**
 * The limit claims in board text the chat writes: For you todos, which the owner reads and answers, and plan steps (text, note, waitFor), which
 * the chat and its jobs act on. Step text is where the Crawler VP put metal's 75 MB/s line that gated census (c43).
 */
export function boardLimitClaims(ops: readonly BoardOp[], names: readonly string[] = []): string[] {
  const texts = (op: BoardOp): unknown[] => {
    if (op.op === "todo_add" || op.op === "todo_update") return [op.text];
    if (op.op === "plan_add") return [op.text, op.waitFor];
    if (op.op === "plan_update") return [op.text, op.note, op.waitFor];
    if (op.op === "plan_set") return op.items.flatMap(function items(item): unknown[] { return [item.text, item.note, item.waitFor, ...(item.children ?? []).flatMap(items)]; });
    return [];
  };
  return ops.flatMap(texts).flatMap(text => typeof text === "string" ? unmeasuredLimits(proseLines(withoutNames(text, names))) : []).map(claim => `"${claim}"`);
}

/** The chat_board flag for board text with limit claims, or null: the claims and the unmeasured hint. The ops are saved either way. */
export function boardLimitFlag(ops: readonly BoardOp[], names: readonly string[] = []): string | null {
  const claims = boardLimitClaims(ops, names);
  return claims.length ? `Saved, but a todo or plan step states a limit with no evidence ${claims.join(", ")} (c43). Fix it with plan_update or todo_update: ${UNMEASURED_HINT}.` : null;
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const CODE = /`[^`]+`/g;
const URL = /https?:\/\/\S+/g;
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d|\u300c[^\u300d\n]*\u300d/g;
/** What stands in for a removed link, code span, URL or quote: no word, but a name for the word after it. */
const GAP = " \u00a7 ";
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;

/** The text's prose lines, outside code fences and quoted ('>') lines, with images, links, code spans, URLs and quotes dropped. */
function proseLines(text: string): { words: string }[] {
  const lines: { words: string }[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence || /^\s*>/.test(line)) continue;
    lines.push({ words: line.replace(IMAGE, GAP).replace(LINK, GAP).replace(CODE, GAP).replace(URL, GAP).replace(QUOTED, GAP) });
  }
  return lines;
}

const clipQuote = (text: string, max = 40): string => text.length > max ? text.slice(0, max - 1).trimEnd() + "\u2026" : text;

/** The internal terms in text the owner reads on the board, such as a For you todo (c32); links, code, URLs and quotes are not read. */
export function jargonTerms(text: string): string[] {
  const found: string[] = [];
  for (const line of proseLines(text)) {
    for (const rule of WORD_RULES) {
      for (const match of line.words.matchAll(RULE_REGEX.get(rule)!)) {
        if (!rule.keep?.(line.words.slice(0, match.index))) found.push(match[0].toLowerCase().replace(/\s+/g, " "));
      }
    }
  }
  return [...new Set(found)];
}

/**
 * Shop talk in a message to the owner, each with what to say instead (c18, c135, c138). The text rule held in the brief since 75ef234f, and
 * the owner still gave c18 again: on 10-18 he quoted `lands`, `then come`, `rolls out` back to ops guy, and on 10-19 frontend bro's "Killed
 * the zero-result filter check" and "The wiring is mostly fine" drew c138 and c135. Of 169 tell_owner texts from 10-19 14:00Z to 22:30Z, after
 * c135 asked for KST, 21 still gave a UTC time and 12 said land or landing.
 */
const SHOP_TALK: readonly { rule: RegExp; plain: string }[] = [
  { rule: /\b\d{1,2}:\d{2}(?::\d{2})?\s?Z\b|\bUTC\b/gu, plain: "give the time in KST, like 23:50 KST or 밤 11시 50분, never UTC or a Z (c135)" },
  { rule: /\b(?:lands|landed)\b|\bland(?:ing)? (?:it|them|this|that|the|a|an|its|his|their|our|my|your)\b/giu,
    plain: "say what he gets, like it is live on staging or the fix is in" },
  { rule: /\broll(?:s|ed|ing)? (?:it |them |this |that )?out\b|\brollouts?\b/giu, plain: "say when it goes live" },
  { rule: /\bkilled the\b/giu, plain: "say what you removed or turned off, with a subject, like I turned off the check that ..." },
  { rule: /\bwiring\b|\bwired (?:up|in)\b/giu, plain: "say what is connected to what" },
  { rule: /(?<![\w/.-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w/.-])/gu, plain: "leave the commit id out and say what changed (c12)" },
];
export const SHOP_TALK_MARK = "Not sent, it has shop talk";

/**
 * The shop talk in a tell_owner text, as "word (what to say instead)", outside links, code, URLs and quotes. A word the owner used in
 * `ownerText`, his message it answers, stays his word.
 */
export function shopTalk(text: string, ownerText = ""): string[] {
  const his = ownerText.toLowerCase();
  const found = new Map<string, string>();
  for (const line of proseLines(text)) {
    for (const { rule, plain } of SHOP_TALK) {
      for (const match of line.words.matchAll(rule)) {
        const word = match[0].trim();
        if (!his.includes(word.toLowerCase()) && !found.has(word.toLowerCase())) found.set(word.toLowerCase(), `"${word}" (${plain})`);
      }
    }
  }
  return [...found.values()];
}

/** The part of an owner message the owner wrote: no injected skill text. Undefined for a server note or a message with no text. */
export function ownerMessage(message: ThreadMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const text = messageText(message).trim();
  return text && !serverNote(text) ? text.replace(SKILL_BLOCK, " ").trim() : undefined;
}
