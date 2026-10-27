import type { BoardOp } from "./types.ts";

/**
 * A For you todo or an owner wait on a plan step that asks the owner whether to keep, narrow or scope a cautious setting (a hold, pause, cap,
 * limit, throttle or timeout) and cites no measurement of the harm it prevents (c72, rule 7). The rule held only as text, and it did not hold:
 * on 10-26 each prod crawler deploy started a 600 s engage opening hold that starved Watchlist reads three times, nothing measured backed the
 * hold, and Prospect feature bro asked t33 "Keep that pause only for a database restore?" with two choices that both kept it, while p230's note
 * said making it restore-only "needs his ok". The owner answered on 10-27 01:05Z: "why pause/do all that bespoke bullshit at all?" (c72 repeat).
 * The ops are saved either way (soft, c98).
 */
const SETTING = String.raw`\b(?:holds?(?!\s+(?:the|a|an|only|them|it|its|their|on|off|onto|up|back|still)\b)|paus(?:e|es|ed|ing)|caps?|capped|limits?|` +
  String.raw`throttl(?:e|es|ed|ing)|time-?outs?|cool-?downs?|back-?offs?|delays?|freezes?|(?:stop|pressure|wait)\s+lines?)\b`;
const KEEP = new RegExp(String.raw`\b(?:keep(?:s|ing)?|kept|retain(?:s|ed|ing)?|narrow(?:s|ed|ing|er)?|scop(?:e|es|ed|ing)|only|restrict(?:s|ed|ing)?|` +
  String.raw`shorten(?:s|ed|ing)?|lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)|halv(?:e|es|ed|ing)|just\s+for|limit(?:s|ed)?\s+(?:it|them)\s+to|[\w-]+-only)\b`, "giu");
const SETTING_WORD = new RegExp(SETTING, "iu");
const NEGATED = /\b(?:never|not|no|don['\u2019]?t|won['\u2019]?t|without|instead\s+of|rather\s+than)\b[^.?!;]{0,40}$/iu;
const OWNER_WAIT = /\b(?:his|the\s+owner['\u2019]s|owner['\u2019]s|sieun['\u2019]s)\s+(?:ok(?:ay)?|go|answer|pick|call|say-?so|approval|decision|word)\b|\bneeds?\s+(?:his|the\s+owner)\b|\bask(?:s|ed|ing)?\s+(?:the\s+owner|him|sieun)\b|\bfor\s+you\b|\b(?:the\s+)?owner\s+(?:decides|is\s+deciding|to\s+decide|picks?)\b/iu;
/** The settings the owner keeps for himself (sieun-pi AGENTS.md: pi-pool's account limits, c98's money, auth and vendor limits). */
const OWNERS_OWN = /\bpi-pool\b|\b(?:account|usage)\s+limits?\b|\bmove\s+budgets?\b|\bturn\s+queue\b|\badmission\s+thresholds?\b|\bvendor['\u2019]?s?\s+(?:rate\s+)?limits?\b|\bthe\s+owner\s+set\b|\$\d|\bspend(?:ing)?\b|\bbilling\b|\bauth\b|\bsecurity\b/iu;
const CITE = /\d|https?:\/\//u;
const PREVENTS = new RegExp(String.raw`\bwithout\s+(?:the\s+|a\s+|that\s+|this\s+|its\s+)?(?:[\w-]+\s+){0,2}?${SETTING}|\bprevent\w*|\bstop(?:s|ped)\b|\bavoid\w*|\bprotect\w*|` +
  String.raw`\bguards?\b|\bincidents?\b|\bmeasur\w+|\bbroke\b|\bcorrupt\w*|\bban(?:s|ned)?\b|\block(?:ed)?\s+out\b|\blockouts?\b`, "iu");
const DENIED = /\b(?:no|not|never|nothing|none)\b|n['\u2019]t\b/iu;
const SENTENCE = /(?<=[.!?;])\s+|\n+/;
const CLAUSE = /,\s+|\s+(?:or|and|so|but)\s+|\s+\/\s+/iu;
const ASIDE = /\([^()]*\)/gu;
const NEAR = 6;
/** A sentence that states this check or the rule, like a step note that describes the flag. */
const RULE = /\b(?:flags?|flagged|refuses?|board\s+check)\b/iu;
const words = (text: string): string[] => text.split(/\s+/u).filter(Boolean);

const clip = (text: string, max = 90): string => text.length > max ? text.slice(0, max - 1).trimEnd() + "\u2026" : text;
const sentences = (text: string): string[] => text.split(SENTENCE).map(sentence => sentence.trim()).filter(Boolean);

/**
 * Whether a sentence asks to keep, narrow or scope a cautious setting: one clause has a keep word that no "never" or "instead of" rules out, and a
 * setting within NEAR words of it, outside brackets. "Fix the stuck discovery pause so the index fills, or only track gaps for now?" (a Douyin
 * todo, 10-18) keeps nothing, and "Keep Claude and wait for caps to reset" (10-22) keeps an account.
 */
function keepsSetting(sentence: string): boolean {
  if (OWNERS_OWN.test(sentence) || RULE.test(sentence)) return false;
  return sentence.replace(ASIDE, " ").split(CLAUSE).some(clause => [...clause.matchAll(KEEP)].some(hit => !NEGATED.test(clause.slice(0, hit.index)) &&
    SETTING_WORD.test(words(clause.slice(0, hit.index)).slice(-NEAR).join(" ") + " " + words(clause.slice(hit.index)).slice(0, NEAR + 1).join(" "))));
}
/** A sentence that backs a setting: a number or link, and the harm the setting prevents ("without the hold, 40 accounts locked out"). */
const backs = (sentence: string): boolean => CITE.test(sentence) && PREVENTS.test(sentence) && !DENIED.test(sentence);

/** The sentence of a todo that asks to keep, narrow or scope an unmeasured setting: a question or a choice, with no backing in the todo. */
export function todoHoldAsk(text: string, choices: readonly string[] = []): string | null {
  const lines = [...sentences(text), ...choices];
  if (lines.some(backs)) return null;
  return [...sentences(text).filter(sentence => sentence.endsWith("?")), ...choices].find(keepsSetting) ?? null;
}
/** The sentence of a plan text, note or wait that holds such a change for the owner's ok, with no backing in it or the sentence before it. */
export function stepHoldWait(text: string): string | null {
  const lines = sentences(text);
  return lines.find((sentence, index) => keepsSetting(sentence) && OWNER_WAIT.test(sentence) && !backs(sentence) && !(index > 0 && backs(lines[index - 1]!))) ?? null;
}

/** Each ask in the ops, clipped to quote. */
export function holdAsks(ops: readonly BoardOp[]): string[] {
  const step = (texts: readonly unknown[]): (string | null)[] => texts.map(text => typeof text === "string" ? stepHoldWait(text) : null);
  return ops.flatMap(op => {
    if (op.op === "todo_add" || op.op === "todo_update") return [typeof op.text === "string" || op.choices ? todoHoldAsk(op.text ?? "", op.choices ?? []) : null];
    if (op.op === "plan_add" || op.op === "plan_update") return step([op.text, op.note, op.waitFor]);
    if (op.op === "plan_set") return op.items.flatMap(function items(item): (string | null)[] { return [...step([item.text, item.note, item.waitFor]), ...(item.children ?? []).flatMap(items)]; });
    return [];
  }).flatMap(hit => hit ? [`"${clip(hit)}"`] : []);
}

/** The chat_board flag for an ask to keep, narrow or scope an unmeasured setting, or null. */
export function holdAskFlag(ops: readonly BoardOp[]): string | null {
  const asks = holdAsks(ops);
  return asks.length ? `Saved, but this asks the owner to keep, narrow or scope a cautious setting ${asks.join(", ")} and cites no measured harm it ` +
    "prevents (c72, rule 7; owner 10-27: \"why pause/do all that bespoke bullshit at all?\"). Do not ask him: delete the setting now, or tell the job " +
    "that owns it to delete it, then remove the todo with todo_remove or reword the step, and tell the owner what you deleted. A broad design pick " +
    "is not the owner setting the number. If a measurement or incident does back it, cite it with its numbers in the same text." : null;
}
