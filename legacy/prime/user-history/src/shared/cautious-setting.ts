import { holdAsks } from "./hold-ask.ts";
import { laneHolds } from "./lane-hold.ts";
import type { BoardOp } from "./types.ts";

/*
 * Cautious settings a text keeps, adds or asks the owner about with no measured harm behind them (c72, rule 7). The owner, 10-14: "you keep
 * instinctually making bad defaults, overly safe bullshit behaviour", after a chat put "whether to log the 10 expired accounts back in" on For
 * you; 10-15: "blockered in nvme IOPS??? you kidding??", after census sat under metal's IO stop line; 10-27: "why pause/do all that bespoke
 * bullshit at all?", after t33 asked to keep a 600 s pause only for restores. hold-ask.ts and lane-hold.ts saw only the last two shapes, and
 * only on the board, so a tell_owner text, a job brief or a step note that kept a pause, an idle account, an avoided login, a held push, a
 * country pin or another chat's stop line went through. On 10-14 a chat asked "switch the pause off by hand on prod now" in five tell_owner
 * messages while reads fell from 48% green to 7.8%.
 */

/** One hit: the rule-7 case it is and the sentence, clipped to quote. */
export interface CautiousHit { kind: CautiousKind; sentence: string }
export type CautiousKind = "kept-setting" | "caution-only" | "stop-line" | "held-until" | "held-push" | "idle-account" | "avoided-login" |
  "switch-off-ask" | "login-ask" | "country";

const SETTING = String.raw`(?:holds?(?!\s+(?:the|a|an|them|it|its|their|on|off|onto|up|back|ok|all|every|\d|[0-9a-f]{7,})\b)|pauses?|paused|caps?|capped|throttl(?:e|es|ed|ing)|cool-?downs?|back-?offs?|delays?|freezes?|` +
  String.raw`safety\s+(?:pauses?|stops?|watch|guards?|switch(?:es)?)|(?:stop|pressure|safety|io|iops|disk|write)\s+lines?|brakes?|kill\s+switch(?:es)?)`;
const SETTING_WORD = new RegExp(String.raw`\b${SETTING}\b`, "iu");
/** A path or file name, whose words ("replay-hold.json") name no setting. */
const PATH = /\S*[/\\]\S*|\S+\.(?:json|md|ts|py|txt|log|yml|yaml)\b/gu;
/** The limits the owner keeps for himself: pi-pool and its model accounts, money, auth and vendor limits (sieun-pi AGENTS.md, c98). */
const OWNERS_OWN = /\bpi-pool\b|\b(?:account|usage)\s+limits?\b|\bmove\s+budgets?\b|\bturn\s+queue\b|\badmission\s+thresholds?\b|\bvendor['\u2019]?s?\s+(?:rate\s+)?limits?\b|\bthe\s+owner\s+set\b|\$\d|\bspend(?:ing)?\b|\bbilling\b|\bauth\b|\bsecurity\b|\b(?:claude|codex|openai|anthropic|gemini|max\s+plans?)\b|\bagent\s+slots?\b|\b5180\b|\bc\d{1,3}\b|\bowner(?:['\u2019]s)?\s+(?:chose|picked|asked|set|said|wants|ruled)\b|\bowner['\u2019]s\s+(?:hold|number|limit|cap|t\d+)\b/iu;
/** Product behavior for users, like a workspace that starts paused until its user presses Start. */
const PRODUCT = /\b(?:users?|customers?|admins?|workspaces?|anyone|visitors?|sign(?:s|ing)?\s+up|sellers?)\b/iu;
/** A measurement or incident the setting prevents, or a failure seen without it: "without the hold, 40 accounts locked out", "every crawl times out". */
const PREVENTS = /\bprevent\w*|\bavoid\w*|\bprotect\w*|\bguards?\s+against\b|\bincidents?\b|\bbroke\b|\bcorrupt\w*|\bban(?:s|ned)?\b|\block(?:ed)?\s+out\b|\blockouts?\b|\boverload\w*|\bOOM\b|\boutages?\b/iu;
const FAILED = /\btim(?:es|ed)\s+out\b|\bcrash(?:es|ed)\b|\b(?:429|5\d\d)s?\b|\bfail(?:s|ed|ing|ures?)\b|\bbroken\b|\bdata\s+loss\b/iu;
const CITE = /\d|https?:\/\//u;
const DENIED = /\bno\s+(?:measur\w+|numbers?|data|incidents?|evidence)\b|\b(?:not|never)\s+(?:been\s+)?measured\b|\bnothing\s+(?:measured|shows)\b|\bunmeasured\b|\bno\s+one\s+measured\b/iu;
const backed = (sentence: string): boolean => !DENIED.test(sentence) && ((CITE.test(sentence) && PREVENTS.test(sentence)) || FAILED.test(sentence));
/** A sentence that states a check or this rule, like a step note that describes a flag, or one that deletes the setting. */
const ABOUT_CHECK = /(?<!\b(?:get|gets|got|getting|be|been|being|are|were|is|was)\s)\bflag(?:s|ged)?\b|\b(?:refuses?|board\s+check|clean[- ]room|c72|rule\s+7)\b/iu;
const REMOVES = /\b(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|drop(?:s|ped|ping)?|strip(?:s|ped)?|rip(?:s|ped)?\s+out|took\s+out|take\s+out|lift(?:s|ed|ing)?|rais(?:e|es|ed|ing)|unpaus\w*|turn(?:s|ed|ing)?\s+off|switch(?:es|ed|ing)?\s+off|gone|no\s+longer|ends?|ended)\b/iu;

const NEGATED_BEFORE = /\b(?:never|not|no|don['\u2019]?t|won['\u2019]?t|without|instead\s+of|rather\s+than)\b[^.?!;]{0,40}$/iu;
const KEEP = /\b(?:keep(?:s|ing)?(?!\s+\w+ing\b)|kept|retain(?:s|ed|ing)?|narrow(?:s|ed|ing|er)?|leav(?:e|es|ing)\s+(?:\S+\s+){0,4}?in\s+place|left\s+(?:\S+\s+){0,4}?in\s+place|[\w-]+-only|only\s+(?:after|for|on|during|when)|shorten(?:s|ed|ing)?|halv(?:e|es|ed|ing))\b/giu;
const ADDS = /\b(?:add(?:s|ed|ing)?|put(?:s|ting)?\s+in|introduc(?:e|es|ed|ing)|set(?:s|ting)?\s+up|turn(?:s|ed|ing)?\s+on|switch(?:es|ed|ing)?\s+on)\b/giu;
const CAUTION_ONLY = /\b(?:to\s+be\s+safe|safer|just\s+in\s+case|as\s+a\s+precaution|for\s+safety|careful(?:ly)?|cautious(?:ly)?|conservative(?:ly)?|to\s+stay\s+safe|play\s+it\s+safe)\b/iu;
const STOP_LINE = /\b(?:(?:stop|pressure|safety|io|iops|disk|write)\s+lines?|safety\s+stops?)\b/iu;
const STOP_LINE_HOLDS = /\b(?:stays?|stayed|sits?|sat|holds?|held|caps?|capped|pauses?|paused|waits?|under|keeps?|kept|blocks?|blocked|blockered)\b/iu;
const HELD_UNTIL = /\b(?:stays?|stayed|remains?|remained|is|are|kept|keep|keeps|held|hold|holds|left|leave)\s+(?:\w+\s+)?(?:off|paused|stopped|on\s+hold|parked|frozen|held|disabled|shut)\s+(?:until|till|pending|before)\b/iu;
const HELD_PUSH = /\b(?:hold|holding|held)\s+(?:off\s+(?:\S+\s+){0,4}?|(?:back\s+)?(?:the|this|that|my|our)\s+(?:[\w-]+\s+)?)(?:push|promote|merge|release|deploy|ship)(?:es|s|ed|ing)?\b|\b(?:push|promote|merge|release|deploy)(?:es|s)?\s+(?:stays?|is|are)\s+(?:on\s+)?held\b|\b(?:wait|hold)\s+(?:\S+\s+){0,2}?(?:to|before\s+(?:we\s+)?)(?:push|promote|merge|ship)\b/iu;
const ACCOUNTS = String.raw`(?:accounts?|profiles?|cookies)`;
const IDLE = new RegExp(String.raw`\b(?:keep(?:s|ing)?|kept|leav(?:e|es|ing)|left|stay(?:s|ed)?|park(?:s|ed)?|hold(?:s|ing)?|held|reserv(?:e|es|ed))\b(?:\s+\S+){0,6}?\s+(?:idle|unused|spares?|in\s+reserve|as\s+(?:a\s+)?(?:reserve|backups?|spares?)|logged[\s-]?out|signed[\s-]?out|offline)\b`, "iu");
const ACCOUNT_WORD = new RegExp(String.raw`\b${ACCOUNTS}\b`, "iu");
const LOG_IN = String.raw`(?:re-?)?(?:log|sign)\s+(?:\S+\s+){0,5}?(?:back\s+)?in\b|re-?log\b`;
/** An ask whether to log accounts in: "whether to log the 10 expired accounts back in", "Should we sign these 10 in now", or a todo that opens "Log ... in". */
const LOGIN_ASK = new RegExp(String.raw`\b(?:whether|should|shall|ok(?:ay)?\s+to|(?:can|may)\s+(?:I|we)|want\s+(?:me|us)\s+to)\b[^.?!]{0,40}?\b${LOG_IN}|^${LOG_IN}`, "iu");
const OWNER_LOGS_IN = /\byou(?:r)?\s+(?:to\s+)?(?:\S+\s+){0,2}?(?:log|sign|password|login|passkey|2fa|code)\b|\bat\s+the\s+machine\b|\bin\s+aside\b/iu;
const AVOIDED_LOGIN = /\b(?:do\s+not|don['\u2019]?t|never|skip|avoid|hold\s+off\s+on|stop)\s+(?:\S+\s+){0,1}?(?:re-?)?(?:log(?:ging)?\s+(?:\S+\s+){0,4}?in\b|sign(?:ing)?\s+(?:\S+\s+){0,4}?in\b|re-?log\w*)/iu;
const SWITCH_OFF = new RegExp(String.raw`\b(?:turn|switch|shut|flip|set)(?:s|ed|ing|ting)?\s+(?:\S+\s+){0,5}?${SETTING}\s+(?:\S+\s+){0,1}?off\b|\b(?:turn|switch|shut)(?:s|ed|ing)?\s+off\s+(?:\S+\s+){0,4}?${SETTING}|` +
  String.raw`\b(?:lift|remove|drop|delete|disable|raise|unpause|clear|end)(?:s|ed|ing)?\s+(?:\S+\s+){0,4}?${SETTING}`, "iu");
/** An ask to put idle or spare accounts to work: "Want me to drop the 6 spares too?", "Should we use the reserve accounts?". */
const SPARES_OFF = /\b(?:drop|remov|us|put|mov|free|wak|activat|lift|zero)\w*\s+(?:\S+\s+){0,4}?(?:spares?|idle\s+(?:accounts?|profiles?)|reserve\s+(?:accounts?|profiles?))\b/iu;
const ASKS = /\?\s*$|\bwhether\b|\bfor\s+you\b|\byour\s+(?:ok|okay|go|pick|call|answer|approval|say-?so)\b|\bshould\s+(?:I|we)\b|\b(?:can|may)\s+(?:I|we)\b|\bwant\s+me\s+to\b|\bok\s+to\b/iu;
const PROXY = /\b(?:geonode|proxy|proxies|exit\s+nodes?|exits?|residential|ip\s+pool)\b/iu;
const COUNTRY = /\bcountry\s*[=:]|\b(?:pin|lock|restrict|limit|route|use|pass|add|set|ask\s+for|pick|choose|only)\w*\s+(?:\S+\s+){0,4}?(?:countr(?:y|ies)|US|USA|KR|Korea|Korean|Seoul|Japan|JP|EU)\b|\b(?:US|USA|KR|Korea|Korean|Seoul|Japan|JP|EU)[\s-]+(?:only\s+)?(?:pool|exits?|proxies|nodes?)\b/u;
const NO_COUNTRY = /\b(?:no|without|drop(?:s|ped)?|remov(?:e|es|ed|ing)|strip(?:s|ped)?|never)\s+(?:\S+\s+){0,2}?countr(?:y|ies)\b/iu;

const SENTENCE = /(?<=[.!?;])\s+|\n+/;
const CLAUSE = /,\s+|\s+(?:or|but|so)\s+|\s+\/\s+/iu;
const ASIDE = /\([^()]*\)/gu;
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d|`[^`\n]*`/gu;
const NEAR = 6;
const words = (text: string): string[] => text.split(/\s+/u).filter(Boolean);
const clip = (text: string, max = 110): string => text.length > max ? text.slice(0, max - 1).trimEnd() + "\u2026" : text;
export const sentencesOf = (text: string): string[] => text.replace(QUOTED, " ").replace(PATH, " ").split(SENTENCE).map(sentence => sentence.trim()).filter(Boolean);

/**
 * Whether a clause has a verb from `verbs` that no "never" or "instead of" rules out, with a setting within NEAR words of it: after it only
 * when `forward` ("adds a 30 min cool-down", not "no cap was added"), on either side otherwise ("keep that pause", "the hold restore-only").
 */
function verbNearSetting(sentence: string, verbs: RegExp, forward = false): boolean {
  return sentence.replace(ASIDE, " ").split(CLAUSE).some(clause => [...clause.matchAll(verbs)].some(hit => !NEGATED_BEFORE.test(clause.slice(0, hit.index)) &&
    SETTING_WORD.test((forward ? "" : words(clause.slice(0, hit.index)).slice(-NEAR).join(" ") + " ") + words(clause.slice(hit.index)).slice(0, NEAR + 2).join(" "))));
}

/** The case a sentence states: a setting it keeps, adds for caution, holds under another chat's line or until a fix, a held push, idle accounts or an avoided login, a country pin. */
function statedCase(sentence: string, asking = false): CautiousKind | null {
  if (COUNTRY.test(sentence) && PROXY.test(sentence) && !NO_COUNTRY.test(sentence)) return "country";
  if (STOP_LINE.test(sentence) && STOP_LINE_HOLDS.test(sentence.replace(STOP_LINE, " ")) && !REMOVES.test(sentence)) return "stop-line";
  if (HELD_UNTIL.test(sentence)) return "held-until";
  if (laneHolds([{ op: "plan_add", text: sentence }]).length) return "held-until";
  if (HELD_PUSH.test(sentence) && !NEGATED_BEFORE.test(sentence.slice(0, HELD_PUSH.exec(sentence)!.index))) return "held-push";
  if (ACCOUNT_WORD.test(sentence) && IDLE.test(sentence) && !NEGATED_BEFORE.test(sentence.slice(0, IDLE.exec(sentence)!.index))) return "idle-account";
  if (ACCOUNT_WORD.test(sentence) && AVOIDED_LOGIN.test(sentence)) return "avoided-login";
  if (CAUTION_ONLY.test(sentence) && SETTING_WORD.test(sentence) && !REMOVES.test(sentence)) return "caution-only";
  if (verbNearSetting(sentence, KEEP) && (asking || !REMOVES.test(sentence))) return "kept-setting";
  if (!REMOVES.test(sentence) && verbNearSetting(sentence, ADDS, true)) return "kept-setting";
  return null;
}

/** The case an ask states: one that asks the owner to switch off a setting the chat may switch off itself, or whether to log accounts in. */
function askedCase(sentence: string): CautiousKind | null {
  if (SWITCH_OFF.test(sentence) || SPARES_OFF.test(sentence)) return "switch-off-ask";
  if (LOGIN_ASK.test(sentence) && ACCOUNT_WORD.test(sentence) && !OWNER_LOGS_IN.test(sentence)) return "login-ask";
  return null;
}

/**
 * Each sentence of a text that keeps, adds or holds a cautious setting with no measured harm in it or the sentences next to it, or, when
 * `asks` (a todo, a tell_owner text), asks the owner to switch one off or whether to log accounts in, which the chat decides itself
 * whatever the numbers say: on 10-14 the chat cited 2 of 35 accounts banned in 3 days and asked, and the owner called it overly safe. A sentence that names one of the
 * owner's own limits, deletes the setting or describes this check passes. A todo is an ask as a whole; another text asks in a question,
 * a "whether", or a For you line.
 */
export function cautiousSettings(text: string, options: { asks?: boolean; todo?: boolean } = {}): CautiousHit[] {
  const lines = sentencesOf(text);
  const hits: CautiousHit[] = [];
  lines.forEach((sentence, index) => {
    if (OWNERS_OWN.test(sentence) || ABOUT_CHECK.test(sentence) || PRODUCT.test(sentence)) return;
    const asking = options.asks === true && (options.todo === true || ASKS.test(sentence));
    const asked = asking ? askedCase(sentence) : null;
    const kind = asked ?? (backed(sentence) || (index > 0 && backed(lines[index - 1]!)) || (index + 1 < lines.length && backed(lines[index + 1]!)) ? null : statedCase(sentence, asking));
    if (kind) hits.push({ kind, sentence: clip(sentence) });
  });
  return hits;
}

const WHAT: Record<CautiousKind, string> = {
  "kept-setting": "keeps, narrows or adds a hold, pause, cap or delay",
  "caution-only": "adds a setting only to be safe",
  "stop-line": "holds work under a stop or pressure line",
  "held-until": "holds work off until a land, fix or review",
  "held-push": "holds a push, merge or promote",
  "idle-account": "keeps accounts idle, spare or logged out",
  "avoided-login": "avoids logging accounts in",
  "switch-off-ask": "asks the owner to switch off a setting you can switch off",
  "login-ask": "asks the owner whether to log accounts in",
  "country": "pins a proxy country",
};
/** The hits as one quoted list: what each does and its sentence. */
export const cautiousList = (hits: readonly CautiousHit[]): string => hits.map(hit => `${WHAT[hit.kind]} ("${hit.sentence}")`).join(", ");

/** The fix for a cautious setting, said the same way wherever it is found. */
export const CAUTIOUS_FIX = "Rule 7 and c72 say default to the high-throughput option: delete the setting, raise the line or log the accounts " +
  "in yourself now, or tell the job that owns it to, and never ask the owner to keep a narrower version or to switch it off for you (owner " +
  "10-27: \"why pause/do all that bespoke bullshit at all?\"). A line another chat set is yours to raise or remove; tell that chat. Keep a " +
  "setting only with the measured harm it prevents in the same text, with its number, or when it is the owner's own number";

/** Each hit in board ops: a todo's text and choices as asks, a plan step's text, note and wait as statements. */
export function boardCautious(ops: readonly BoardOp[]): CautiousHit[] {
  const step = (texts: readonly unknown[]): CautiousHit[] => texts.flatMap(text => typeof text === "string" ? cautiousSettings(text) : []);
  return ops.flatMap(op => {
    if (op.op === "todo_add" || op.op === "todo_update") return [op.text ?? "", ...op.choices ?? []].flatMap(text => cautiousSettings(text, { asks: true, todo: true }));
    if (op.op === "plan_add" || op.op === "plan_update") return step([op.text, op.note, op.waitFor]);
    if (op.op === "plan_set") return op.items.flatMap(function items(item): CautiousHit[] { return [...step([item.text, item.note, item.waitFor]), ...(item.children ?? []).flatMap(items)]; });
    return [];
  });
}

const head = (text: string): string => text.replace(/^"|\u2026"?$|"$/gu, "").slice(0, 40).toLowerCase();
/**
 * The chat_board flag for a cautious setting the ops keep, add or ask about (`boardCautious`), or null. A sentence the hold-ask or lane-hold
 * flag already quotes is left to that flag. The ops are saved either way (soft, c98).
 */
export function cautiousFlag(ops: readonly BoardOp[]): string | null {
  const quoted = [...holdAsks(ops), ...laneHolds(ops)].map(head);
  const hits = boardCautious(ops).filter(hit => !quoted.some(quote => quote.startsWith(head(hit.sentence).slice(0, 30)) || head(hit.sentence).includes(quote.slice(0, 30))));
  return hits.length ? `Saved, but this ${cautiousList(hits)}, with no measured harm behind it (c72, rule 7). ${CAUTIOUS_FIX}. Then reword the ` +
    "step with plan_update or take the todo back with todo_remove, and tell the owner what you deleted or raised." : null;
}
