import { chatLines, FENCE, REPLY_CHECK_PREFIX, REPLY_FOLD_WORDS, replyWordCount, serverNote } from "./chat-feed.ts";
import { messageText } from "./turns.ts";
import type { BoardOp, ThreadMessage } from "./types.ts";

/**
 * The reply lint: what in a reply to the owner breaks the reply rules (correction c1/c18, owner 10-08 and 10-09: "unslop, you are talking so
 * much slop", "두번째 단계가 뭐고 pi server가 뭘계산한다는거야"). tell_owner refuses text with findings; the chat server sends a `[reply check]`
 * after an owner turn whose last reply had findings; the model's view carries the findings of the reply before each owner message; Chat
 * health counts replies with findings other than length (slop_replies). A limit with a rate or size and no evidence in its own sentence is a
 * finding too, in a reply, a todo, a plan step or an agent message a chat sends (c43, owner 10-12: "what is the bottleneck actual IOPS? CPU? RAM??????", "r u fucking kidding?").
 */
export type FindingKind = "long" | "bullets" | "heading" | "label" | "dash" | "bold" | "abstract" | "jargon" | "unmeasured";
export interface Finding { kind: FindingKind; what: string; hint: string }

const BULLETS_MAX = 3;
const BOLD_MAX = 3;
const BOLD_CHARS = 40;
const LABEL_WORDS = 3;
const QUOTE_MAX = 4;

/**
 * A word the owner should not have to decode. `en` are regex sources matched as whole Latin words (a Korean particle may follow, as in "duty가"),
 * `ko` are Korean stems matched at a word start, any ending. `keep` spares one use by what is around it. Any rule whose words the owner used in
 * the message the reply answers is spared whole.
 */
interface WordRule { kind: "abstract" | "jargon"; en?: readonly string[]; ko?: readonly string[]; keep?: (before: string, after: string) => boolean }
const followedByNumber = (_before: string, after: string): boolean => /^\s*\d/.test(after);
/** A number in the rest of the sentence, within 40 characters: "computes 14 metrics". */
const numberSoon = (_before: string, after: string): boolean => /\d/.test(after.split(/[.!?\u3002](?:\s|$)/)[0]!.slice(0, 40));
/** A pipeline named by the word before it (crawler pipeline), not "the pipeline". A removed link or code span counts as a name. */
const named = (before: string): boolean => { const word = before.trimEnd().split(/\s+/).at(-1) ?? ""; return word !== "" && !/^(?:the|a|an|this|that|our|its|their|your|whole|entire|new|이|그|저|전체)$/i.test(word); };
/** "just" meaning a moment ago: "just now", "just landed", any past tense after it. */
/** A product's own term, named by the capitalized word or the link or code span before it (Claude Code hooks, Cal.com hooks). */
const properNamed = (before: string): boolean => /(?:\p{Lu}[\p{L}\p{N}.]*|\u00a7)\s*$/u.test(before);
const RECENT = /^\s+(?:now|before|after|in time|\p{L}+ed|sent|came|went|got|did|made|ran|saw|left|woke|said|told|began|built|found|heard|lost|won|wrote|spoke)(?![\p{L}])/iu;

export const WORD_RULES: readonly WordRule[] = [
  { kind: "abstract", en: ["stages?", "phases?"], ko: ["단계"], keep: followedByNumber },
  { kind: "abstract", en: ["steps?\\s+\\d+", "(?:first|second|third|fourth|last)\\s+(?:step|stage|phase)"], ko: ["스텝"] },
  { kind: "abstract", en: ["comput(?:e|es|ed|ing)"], ko: ["계산"], keep: numberSoon },
  { kind: "abstract", en: ["logic"], ko: ["로직"] },
  { kind: "abstract", en: ["handles", "handling"] },
  { kind: "abstract", en: ["pipelines?"], ko: ["파이프라인"], keep: named },
  { kind: "abstract", en: ["mechanisms?"], ko: ["메커니즘", "매커니즘"] },
  { kind: "abstract", en: ["leverag(?:e|es|ed|ing)", "robust", "seamless(?:ly)?", "comprehensive", "streamlin(?:e|es|ed|ing)", "delv(?:e|es|ed|ing)",
    "utiliz(?:e|es|ed|ing)", "facilitat(?:e|es|ed|ing)", "crucial", "pivotal", "additionally", "essentially", "actually"] },
  { kind: "abstract", en: ["really"], keep: before => /\b(?:not|n't)\s*$/i.test(before) },
  { kind: "abstract", en: ["just"], keep: (_before, after) => RECENT.test(after) },
  { kind: "jargon", en: ["duty", "duties"], ko: ["듀티"] },
  { kind: "jargon", en: ["built[- ]?in"], ko: ["기본으로 들어가", "기본 탑재", "내장"] },
  { kind: "jargon", en: ["pre-?checks?"], ko: ["프리체크"] },
  { kind: "jargon", en: ["digests?"], ko: ["다이제스트"] },
  { kind: "jargon", en: ["steer", "steers", "steered", "steering"], ko: ["스티어"] },
  { kind: "jargon", en: ["check-?in jobs?", "act class(?:es)?", "step class(?:es)?"] },
  { kind: "jargon", en: ["board (?:upkeep|convergence|maintenance)"], ko: ["보드 관리", "보드 정리"] },
  { kind: "jargon", en: ["fan[- ]?outs?", "fans out", "fanned out", "fanning out"], ko: ["팬아웃"] },
  { kind: "jargon", en: ["hooks?"], ko: ["훅"], keep: properNamed },
  { kind: "jargon", en: ["extensions?"], ko: ["익스텐션"], keep: properNamed },
  { kind: "jargon", en: ["catalog(?:ue)?s?"], ko: ["카탈로그"], keep: properNamed },
  { kind: "jargon", en: ["memos?"], ko: ["메모"] },
  { kind: "jargon", en: ["stale-chase", "orphans?", "foryou"] },
];
const ruleRegex = (rule: WordRule): RegExp => new RegExp([
  ...(rule.en?.length ? [`(?<![\\p{Script=Latin}\\p{N}_-])(?:${rule.en.join("|")})(?![\\p{Script=Latin}\\p{N}_-])`] : []),
  ...(rule.ko?.length ? [`(?<![\\p{L}\\p{N}])(?:${rule.ko.join("|")})`] : []),
].join("|"), "giu");
/** c32's own examples (owner 10-09: "unslop easy word"), refused in For you text only: a reply may name a plan the owner already knows. */
const BOARD_NAMES: WordRule = { kind: "jargon", en: ["probe slots?", "land flows?", "key locks?"] };
const RULE_REGEX = new Map([...WORD_RULES, BOARD_NAMES].map(rule => [rule, ruleRegex(rule)]));

const HINTS: Record<FindingKind, string> = {
  long: `cut it to ${REPLY_FOLD_WORDS} words: the answer in one line, then at most 3 short lines; detail goes in a wiki page you link`,
  bullets: `use at most ${BULLETS_MAX} bullets, or plain sentences`,
  heading: "drop the heading and start with the answer",
  label: "drop the label and say it as a normal sentence",
  dash: "use a comma or end the sentence",
  bold: `bold only a short label, at most ${BOLD_MAX} per reply, or none`,
  abstract: "name the real thing instead: what runs, what it reads or counts, the number",
  jargon: "these are our internal names the owner did not use; say what it does for the owner in plain words",
  unmeasured: "in the same sentence, name the resource you measured and how full it was (disk 95% busy, CPU 400%, p99 latency 40 ms, 429s on " +
    "40% of calls), the vendor limit or the incident behind the number; a caution line nobody measured is no limit, so drop it and say you dropped it (c43)",
};

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

/** The chat_board refusal for board text with limit claims, or null: the claims and the unmeasured hint. */
export function boardLimitRefusal(ops: readonly BoardOp[], names: readonly string[] = []): string | null {
  const claims = boardLimitClaims(ops, names);
  return claims.length ? `Refused, nothing changed: a todo or plan step states a limit with no evidence ${claims.join(", ")}. Fix: ${HINTS.unmeasured}.` : null;
}

/**
 * The refusal for an agent message a chat or a job sends with a limit claim, or null. A limit that one session passes to another gets the same
 * check as a reply to the owner, because the receiver acts on it (c43, owner 10-12 22:37 KST, "r u fucking kidding?").
 */
export function messageLimitRefusal(text: string, names: readonly string[] = []): string | null {
  const claims = unmeasuredLimits(proseLines(withoutNames(text, names))).map(claim => `"${claim}"`);
  return claims.length ? `Refused, not sent: this agent message states a limit with no evidence ${claims.join(", ")}. Fix: ${HINTS.unmeasured}. ` +
    "If you only report another session's line, drop the number and ask what it rests on." : null;
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const CODE = /`[^`]+`/g;
const URL = /https?:\/\/\S+/g;
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d|\u300c[^\u300d\n]*\u300d/g;
/** What stands in for a removed link, code span, URL or quote: no word, but a name for the word after it. */
const GAP = " \u00a7 ";
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?=\S)/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const BOLD = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
const BOLD_LEAD = /^(\*\*|__)(?=\S)(.+?)(?<=\S)\1/;
const COLON_LEAD = /^([\p{L}\p{N}][^\s:.,!?]*(?:[ \t]+[^\s:.,!?]+)*?):(?:\*\*|__)?(?=\s|$)/u;
const DASH = /[\u2014\u2013]/g;
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;

/** The reply's prose lines: outside code fences and quoted ('>') lines. `shown` has images dropped and links as their labels; `words` also drops links, code spans, URLs and quotes. */
function proseLines(text: string): { shown: string; words: string }[] {
  const lines: { shown: string; words: string }[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence || /^\s*>/.test(line)) continue;
    const shown = line.replace(IMAGE, "").replace(LINK, "$1");
    lines.push({ shown, words: line.replace(IMAGE, GAP).replace(LINK, GAP).replace(CODE, GAP).replace(URL, GAP).replace(QUOTED, GAP) });
  }
  return lines;
}

const quoteList = (items: readonly string[]): string => {
  const unique = [...new Set(items)];
  return unique.slice(0, QUOTE_MAX).map(item => `"${item}"`).join(", ") + (unique.length > QUOTE_MAX ? ` and ${unique.length - QUOTE_MAX} more` : "");
};
const clipQuote = (text: string, max = 40): string => text.length > max ? text.slice(0, max - 1).trimEnd() + "\u2026" : text;

/** The label a line opens with ("Update:", "**Still open:**", "**Code check.**"), or undefined. */
function labelOpener(shown: string): string | undefined {
  const rest = shown.replace(BULLET, "").replace(CODE, "x").trimStart();
  const bold = BOLD_LEAD.exec(rest);
  if (bold) return bold[0];
  const colon = COLON_LEAD.exec(rest.replace(/^(?:\*\*|__)/, ""));
  return colon && colon[1]!.split(/\s+/).length <= LABEL_WORDS ? `${colon[1]}:` : undefined;
}

/**
 * What in a reply to the owner breaks the reply rules, each with a plain fix: over REPLY_FOLD_WORDS words (counted as the page folds), more than
 * BULLETS_MAX bullets, a heading, a label or colon opener at the start of a line, an em or en dash, bold over BOLD_CHARS characters or more than
 * BOLD_MAX bold spans, abstract words and internal terms (WORD_RULES). Code spans, link targets and labels, quoted text and '>' lines are not
 * read for words; a word rule the owner's own message (`ownerText`) matches is spared.
 */
export function lintOwnerReply(text: string, ownerText = ""): Finding[] {
  const findings: Finding[] = [];
  const add = (kind: FindingKind, what: string) => findings.push({ kind, what, hint: HINTS[kind] });
  const words = replyWordCount(text);
  if (words > REPLY_FOLD_WORDS) add("long", `${words} words`);
  const lines = proseLines(text);
  const bullets = lines.filter(line => BULLET.test(line.shown)).length;
  if (bullets > BULLETS_MAX) add("bullets", `${bullets} bullets`);
  const headings = lines.filter(line => HEADING.test(line.shown)).map(line => clipQuote(line.shown.trim()));
  if (headings.length) add("heading", `heading ${quoteList(headings)}`);
  const labels = lines.flatMap(line => { const label = labelOpener(line.shown); return label ? [clipQuote(label)] : []; });
  if (labels.length) add("label", `label opener ${quoteList(labels)}`);
  const dashes = lines.flatMap(line => [...line.shown.replace(CODE, " ").replace(URL, " ").matchAll(DASH)].map(match => match[0] === "\u2014" ? "em dash" : "en dash"));
  if (dashes.length) add("dash", [...new Set(dashes)].join(" and "));
  const bold = lines.flatMap(line => [...line.shown.matchAll(BOLD)].map(match => match[2]!));
  const longBold = bold.filter(span => span.length > BOLD_CHARS);
  if (bold.length > BOLD_MAX || longBold.length) add("bold", longBold.length ? `bold over ${BOLD_CHARS} characters ${quoteList(longBold.map(span => clipQuote(span)))}` : `${bold.length} bold spans`);
  const found = ruleWords(lines, ownerText.replace(SKILL_BLOCK, " "));
  if (found.abstract.length) add("abstract", `abstract words ${quoteList(found.abstract)}`);
  if (found.jargon.length) add("jargon", `internal terms ${quoteList(found.jargon)}`);
  const limits = unmeasuredLimits(lines);
  if (limits.length) add("unmeasured", `limit with no measurement ${quoteList(limits)}`);
  return findings;
}

/** The words in `lines` that WORD_RULES flag, by kind; a rule the owner's own words (`owner`) match is spared. */
function ruleWords(lines: readonly { words: string }[], owner: string, rules: readonly WordRule[] = WORD_RULES): Record<"abstract" | "jargon", string[]> {
  const found: Record<"abstract" | "jargon", string[]> = { abstract: [], jargon: [] };
  for (const rule of rules) {
    const regex = RULE_REGEX.get(rule)!;
    regex.lastIndex = 0;
    if (owner && regex.test(owner)) continue;
    for (const line of lines) {
      for (const match of line.words.matchAll(regex)) {
        const before = line.words.slice(0, match.index);
        const after = line.words.slice(match.index! + match[0].length);
        if (!rule.keep?.(before, after)) found[rule.kind].push(match[0].toLowerCase().replace(/\s+/g, " "));
      }
    }
  }
  return found;
}

/** The internal terms in text the owner reads on the board, such as a For you todo (c32); links, code, URLs and quotes are not read. */
export const jargonTerms = (text: string): string[] => [...new Set(ruleWords(proseLines(text), "", [...WORD_RULES, BOARD_NAMES]).jargon)];
export const JARGON_HINT = HINTS.jargon;

/** The findings as one line: "74 words; label opener "Update:"". */
export const findingsLine = (findings: readonly Finding[]): string => findings.map(finding => finding.what).join("; ");
/** The findings with their fixes, one per line, for a refusal or a `[reply check]`. */
export const findingsList = (findings: readonly Finding[]): string => findings.map(finding => `- ${finding.what}: ${finding.hint}`).join("\n");

/** The part of an owner message the owner wrote: no injected skill text. Undefined for a server note or a message with no text. */
export function ownerMessage(message: ThreadMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const text = messageText(message).trim();
  return text && !serverNote(text) ? text.replace(SKILL_BLOCK, " ").trim() : undefined;
}
const lineIndex = (id: string): number => Number(id.slice(1).split("-")[0]);

/** The owner's last message in the transcript, for the lint's owner-word check on a tell_owner call; "" when there is none. */
export function lastOwnerText(messages: readonly ThreadMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) { const text = ownerMessage(messages[index]!); if (text !== undefined) return text; }
  return "";
}

/**
 * Each reply the owner read (the feed's agent lines: text on an owner turn, an accepted tell_owner on any turn), in order, with its message index
 * and the owner's message it answers.
 */
function ownerReplies(messages: readonly ThreadMessage[]): { index: number; at: number; text: string; told: boolean; owner: string }[] {
  const lines = chatLines(messages).flatMap(line => line.kind === "agent" ? [{ index: lineIndex(line.id), at: line.at, text: line.text, told: line.told === true }] : []);
  const replies: { index: number; at: number; text: string; told: boolean; owner: string }[] = [];
  let owner = "";
  let next = 0;
  messages.forEach((message, index) => {
    const text = ownerMessage(message);
    if (text !== undefined) owner = text;
    while (next < lines.length && lines[next]!.index === index) replies.push({ ...lines[next++]!, owner });
  });
  return replies;
}

/**
 * The note on each owner message whose previous owner-facing reply had findings, by the owner message's index: "[reply check] Your last owner
 * reply had: ...". Each note depends only on the messages before it, so the model's cached prefix holds.
 */
export function replyNotes(messages: readonly ThreadMessage[]): Map<number, string> {
  const notes = new Map<number, string>();
  const replies = ownerReplies(messages);
  let next = 0;
  let last: (typeof replies)[number] | undefined;
  messages.forEach((message, index) => {
    while (next < replies.length && replies[next]!.index < index) last = replies[next++];
    if (!last || ownerMessage(message) === undefined) return;
    const findings = lintOwnerReply(last.text, last.owner);
    if (findings.length) notes.set(index, `[reply check] Your last owner reply had: ${findingsLine(findings)}. Fix that in this reply.`);
  });
  return notes;
}

/**
 * The `[reply check]` the server sends when a chat's turn ended: when the last reply the owner read is the chat's text on an owner turn with
 * findings. `at` is that reply's time, so the server sends one per reply. Null when the reply passes, was stopped, or was a tell_owner call
 * (tell_owner refuses findings itself).
 */
export function replyCheck(messages: readonly ThreadMessage[]): { at: number; message: string } | null {
  const reply = ownerReplies(messages).at(-1);
  if (!reply || reply.told) return null;
  const message = messages[reply.index];
  if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return null;
  const findings = lintOwnerReply(reply.text, reply.owner);
  if (!findings.length) return null;
  const opening = reply.text.split(/\s+/).slice(0, 8).join(" ");
  return { at: reply.at, message: `${REPLY_CHECK_PREFIX}Your reply to the owner "${opening}\u2026" had:\n${findingsList(findings)}\n` +
    "If it misled the owner or the owner cannot follow it, send one corrected short reply with tell_owner now. Otherwise do not resend it; apply this from your next reply." };
}
