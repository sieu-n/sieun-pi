/*
 * Invented gates (c47: "Do not invent waiting rules, extra review rounds or safety gates; act directly and ship, unless the owner explicitly asks
 * for caution"; the owner 10-12: "stop making up these bullshit rules on waiting", then "NEVER wait for something"). That day job briefs carried
 * "Prod writes are one change per 15-min slot with a clean read-back", "Run the probe only on Fable's explicit slot go" and "WAIT for my exact
 * source freeze instruction and root source review before copying/building". A sentence that adds such a gate passes only when it gives the cause
 * it prevents ("because land 32b's deploy needs the same runners", "429s on 40% of calls") or rests on an owner rule (a correction id, OWNER_OK,
 * the owner's go of c49, the Mac load gate of c58, an outside send of c37), and a staging move never rests on the owner (c50).
 */

/** One gate in a text: the words that make it a gate, and the sentence they sit in. */
export interface InventedGate { phrase: string; sentence: string }

/** What a person hands out before work may go on: a go, a word, a slot, a review. */
const LEAVE = String.raw`(?:go(?:-ahead)?(?![-\w])|ok(?:ay)?\b|approv(?:al|es?|ed)\b|sign-?off|confirmation|word\b|nod\b|green\s+light|say-?so|permission|clearance|slots?\b|review\b|look\b|instruction)`;
const WHO = String.raw`(?:me|us|him|them|the\s+(?:parent|owner|chat|coordinator|keeper|release\s+owner)|[A-Z][\w-]*(?:\s+[A-Z][\w-]*)?)`;
const GATES: readonly RegExp[] = [
  // waiting or holding for someone's leave: "wait for my go", "hold the diff until I relay", "WAIT for my exact source freeze instruction"
  new RegExp(String.raw`\b(?:wait(?:s|ed|ing)?|hold(?:s|ing)?|held|pause[sd]?|park(?:s|ed)?)\b(?:\s+[^\s.;]+){0,3}?\s+(?:for|until|on)\b(?:\s+[^\s.;]+){0,5}?\s+${LEAVE}`, "iu"),
  new RegExp(String.raw`\buntil\s+(?:I|we|he|they|${WHO})\s+(?:say|says|relay|relays|confirm|confirms|approve|approves|give|gives|clear|clears|ok|oks|grant|grants|announce|announces)\b`, "u"),
  // acting only on someone's leave: "at Fable's staging word", "only on Fable's explicit slot go", "after metal's slot", "only after review"
  new RegExp(String.raw`\b(?:at|on|after|upon|with|through|in)\s+(?:the\s+)?(?:[\w-]+\s+)?(?!(?:owner|sieun|today|tomorrow|tonight)['\u2019]s)[\w-]+['\u2019]s\s+(?:[^\s.;,()]+\s+){0,3}?${LEAVE}`, "iu"),
  /\bonly\s+(?:on|after|with|once)\b(?:\s+[^\s.;]+){0,5}?\s+(?:go(?:-ahead)?(?![-\w])|ok\b|approval|sign-?off|review|confirmation|slot)/iu,
  // asking first: "ask me before adding one", "ask it for a slot first", "ask me for the browser slot"
  /\bask(?:s|ing)?\s+(?:\S+\s+){0,3}?(?:before\b|first\b|for\s+(?:a|an|the|its|their|our)?\s*(?:\S+\s+)?(?:slot|go|ok|permission|review|approval|sign-?off|look)\b)/iu,
  // pacing: "one write per 15-min slot", "one change at a time", "2 minutes apart", "a quiet stretch"
  /\bone\s+(?:[\w-]+\s+){0,2}(?:per|each|every)\s+(?:\d+[-\s]?(?:min(?:ute)?s?|h(?:ours?)?)\s+)?(?:slot|window|stretch)\b/iu,
  /\bone\s+(?:[\w-]+\s+){0,2}at\s+a\s+time\b/iu,
  /\b\d+[-\s]?(?:min(?:ute)?s?|hours?|h)\s+(?:apart|between|spacing|gaps?)\b|\b(?:slot|prod)\s+(?:queue|spacing|timetable)\b/iu,
  /\b(?:in|during|for|until|wait\s+for)\s+(?:a\s+|the\s+)?quiet\s+(?:stretch|period|window|time|spell)\b/iu,
  // review rounds and leave as a precondition: "needs a review", "no commit until coordinator review", "after a second review"
  /\b(?:needs?|requires?|gets?)\s+(?:a\s+|an\s+|the\s+|its\s+|one\s+more\s+)?(?:second\s+|another\s+|extra\s+|root\s+|source\s+|code\s+|peer\s+)?(?:review|approval|sign-?off|look)\b/iu,
  // booking leave: "Prod writes need a Crawler VP slot", "get Crawler VP's slot", "take a probe slot"
  /\b(?:needs?|requires?|gets?|takes?|books?|requests?)\s+(?:a|an|the|its|our|their|(?:[\w-]+\s+)?[\w-]+['\u2019]s)\s+(?:[\w/-]+\s+){0,2}?(?:slot|go(?![-\w]))\b/iu,
  /\b(?:review\s+rounds?|second\s+review|another\s+review|extra\s+review)\b/iu,
  /\bno\s+(?:[\w/-]+\s+){1,2}(?:until|without|before)\b(?:\s+[^\s.;]+){0,4}?\s+(?:review|go(?![-\w])|ok\b|approval|sign-?off|confirmation|word|slot|I\s+say)/iu,
  // a go that runs out: "a go older than 30 min", "the go expires"
  /\b(?:go|ok|approval)s?\s+(?:expires?|lapses?|older\s+than|is\s+valid\s+for|lasts?\s+\d)/iu,
];

/*
 * "never wait for", "do not ask", "No source redesign or extra review round is needed", "over adding apps one at a time": a negation or a
 * rejected option earlier in the gate words' own clause removes the gate. A clause ends at a comma, colon, semicolon, bracket or dash, or before
 * "and", "but", "then", "while", "when", "if", "unless", "so" or "because", so "Never walk the sitemap against prod: check one URL at a time"
 * keeps its gate. On 10-22 a two-word reach flagged "No source redesign or extra review round is needed." in a chat-2572 brief.
 */
const CLAUSE_BREAK = /[,:;()\u2013\u2014]|\b(?:and|but|then|while|when|if|unless|so|because)\b/i;
const NEGATED = /\b(?:never|not|no|don['\u2019]?t|doesn['\u2019]?t|without|stop|instead\s+of|rather\s+than|whether)\b|\bover\s+\w+ing\b/i;
const clauseBefore = (sentence: string, at: number): string => sentence.slice(0, at).split(CLAUSE_BREAK).at(-1) ?? "";
/** A wait named as a quantity to measure ("queue wait for a slot", "time waiting for a working slot"), not a wait the job is told to do. */
const MEASURED = /\b(?:queue|time|latency|delay)\s+$/i;
/*
 * A wait on a production step (c74, c154: a prod deploy is a manual step walked with the owner): "After promote 19's prod deploy ok, read the
 * writer lag again", "while waiting for the release or approval" in a message job. The release owner's go is a thread's go, so it stays a gate.
 */
const PROD_STEP = /\bprod(?:uction)?\b|\bpromot(?:e|es|ed|ion)\b|\brelease\b(?!\s+owner)/i;
const passes = (sentence: string, found: RegExpExecArray): boolean =>
  NEGATED.test(clauseBefore(sentence, found.index)) || MEASURED.test(sentence.slice(0, found.index)) || PROD_STEP.test(found[0]);
/** A sentence about a check that finds gates names gate words without adding one; so does a runner's or worker's own "one job at a time" setting. */
const NOT_A_GATE = /\b(?:flags?|refuses?|catch(?:es)?|detects?|lints?)\b/i;
const CAPACITY_SETTING = /\b(?:runners?|workers?|docker)\b/i;
/** The cause the gate prevents, said in the sentence. A cause that is only caution ("to be safe", "just in case") does not count. */
const CAUSE = /\b(?:because|since|due\s+to|so\s+that|otherwise|or\s+else|given\s+that)\b|\b\d+(?:\.\d+)?\s*%|\b(?:429|5\d\d)s?\b|\b(?:OOM|outage|incident|crash(?:ed|es)?|timed\s+out|failed|failures?)\b/i;
const CAUTION_ONLY = /\b(?:to\s+be\s+safe|safer|just\s+in\s+case|careful(?:ly)?|cautio(?:n|us)|avoid\s+(?:any\s+)?risk|piecemeal)\b/i;
/** An owner rule behind the gate: a correction id, the owner's own ruling, the c58 Mac load gate (tests one file at a time, browser checks) or a c37 outside send. */
const OWNER_RULE = new RegExp([
  String.raw`\bc\d{1,3}\b`, String.raw`\b(?:the\s+)?owner\s+(?:asked|said|wants|chose|ruled)\b|\bowner['\u2019]s\s+(?:ruling|rule)\b`,
  String.raw`\b(?:1-?min(?:ute)?\s+)?load\b[^.]{0,30}\b(?:under|below|<)\s*\d|\bload\s+gate\b|\bmemory(?:_pressure)?\b[^.]{0,30}\d+\s*%|\bMac\s+load\b|loadavg`,
  String.raw`\bone\s+(?:test\s+)?file\s+at\s+a\s+time\b|\btest-concurrency\b|\bwith\s+nice\b|\bnice\b,|\bheavy\s+(?:step|process|work)|\bbrowser\s+checks?\b`,
  String.raw`\b(?:e-?mails?|vendor\s+(?:ticket|reply)|outside[-\s]sends?)\b`,
].join("|"), "iu");
/** The owner's go (c49): it backs a gate on production, never one on a staging-only move (c50). */
const OWNER_GO = /\bOWNER_OK\b|\bFor\s+you\b|\b(?:his|the\s+owner['\u2019]s|owner['\u2019]s)\s+(?:explicit\s+)?(?:go|ok|approval)\b/iu;
const STAGING_MOVE = /\bstaging\b|\bsieun\/dev\b|\bci\//i;
const PRODUCTION = /\bprod(?:uction)?\b|\bpromot(?:e|es|ed|ion)\b|\bmain\b|\bmaster\b|\bPRs?\b|#\d+/i;
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d|`[^`\n]*`/g;

/**
 * The invented gates in a text, sentence by sentence, with quoted text and code spans left out. A sentence passes when it states a cause, an
 * owner rule backs it, or the owner's go backs it and it is not a staging-only move.
 */
export function inventedGates(text: string): InventedGate[] {
  const gates: InventedGate[] = [];
  for (const raw of text.replace(QUOTED, " \u00a7 ").split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const match = GATES.map(gate => gate.exec(sentence)).find(found => found && !passes(sentence, found));
    if (!match || NOT_A_GATE.test(sentence) || (/at\s+a\s+time/i.test(match[0]) && CAPACITY_SETTING.test(sentence))) continue;
    if (CAUSE.test(sentence) && !CAUTION_ONLY.test(sentence)) continue;
    if (OWNER_RULE.test(sentence) || (OWNER_GO.test(sentence) && (PRODUCTION.test(sentence) || !STAGING_MOVE.test(sentence)))) continue;
    gates.push({ phrase: match[0], sentence });
  }
  return gates;
}

/** The fix for an invented gate, said the same way wherever it is flagged. */
export const INVENTED_GATE_FIX = "Drop the gate and have the job act now (c47: no waiting rules, review rounds or safety gates the owner did not ask " +
  "for). Keep it only with its cause in the same sentence (\"because land 32b's deploy needs the same runners\", \"429s on 40% of calls\") or the " +
  "owner rule behind it (its correction id).";
