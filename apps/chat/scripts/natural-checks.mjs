/**
 * The checks of blind-replies.mjs `--set natural` and of its list and checklist lines, kept apart so natural-checks.test.mjs can run them on real posts. The owner asked in
 * dm_agent-factory p54 on 11-21 (msg mwqt6ry1): "todo를 리스트하는건 좋은데, 자연스럽게 해야지 메시지면 메시지 context에 맞게, channel 도중이면
 * channel message concept에 맞게. 그리고 follow-up question 물어도 돼 괜찮아 대신 primary suggestion은 꼭 두고", and in p57 (msg mwqtjlth):
 * "이런것도 엔터, bullet point 똑바로 쓰고". He praised a DM reply of an answer line, a short paragraph, a lead-in line, bullets and a closing
 * line (msg mwqtp2l1: "정말 훌륭한 메시지였어"), which natural-checks.test.mjs keeps as the target shape.
 */

/** A text's words as tell_owner's long check counts them (reply-lint.ts `longReply`), with no list or task marker counted. */
export const words = text => text.replace(/\]\([^)]*\)/g, "]").replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "").split(/\s+/).filter(Boolean).length;
const BULLET = /^\s*[-*+] /;
/** A post's sentences; a line break ends one too, since a bullet line seldom ends on a period and 3 bullets read as one 40-word sentence on 11-20. */
export const sentences = text => text.replace(/\]\([^)]*\)/g, "]").split(/(?<=[.!?])\s+|\n+/).filter(line => line.trim());
/** An abbreviation whose period ends no sentence, such as the agent name "Search product, misc." in "Search product, misc. used $808". */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|misc|al|approx)\.$/i;
/**
 * One line's sentences, split where a period, "!" or "?" meets a space outside a code span or link target and after no abbreviation. On
 * 11-24 #sw-factory-build p199 held "Tokens: $2,984 in the last 24 h. Search product, misc. used $808 ..." as two sentences, and a plain
 * split read three.
 */
export const lineParts = line => line.replace(/`[^`\n]*`|\]\([^)]*\)/g, span => span.replace(/[.!?]/g, "_")).split(/(?<=[.!?])\s+/)
  .reduce((parts, part) => (parts.length && ABBREVIATION.test(parts.at(-1)) ? parts.with(-1, `${parts.at(-1)} ${part}`) : [...parts, part]), [])
  .filter(part => /\w/.test(part));
/**
 * The line checks of a list or checklist reply. The comm role text says a bullet stops at two sentences and a third fact gets its own or
 * a nested bullet, so a line holds at most two sentences and the 35-word cap holds per sentence. d4's 11-24 06:45 KST checklist run
 * failed the old 35-word cap per line on one bullet of two sentences, 14 and 27 words, that followed that rule.
 */
export const lineChecks = lines => [
  ["no line holds more than two sentences", lines.every(line => lineParts(line).length <= 2)],
  ["no sentence over 35 words", lines.every(line => lineParts(line).every(sentence => words(sentence) <= 35))],
];
/** A word that makes a line a sentence: a pronoun, an auxiliary, a common verb, or a word ending in -ed or -ing. */
const VERB = /\b(i|i'll|i'm|i've|i'd|we|we'll|we're|we'd|you|you'd|it|it's|they|here's|there's|let's|let me|is|are|was|were|be|been|has|have|had|do|does|did|can|can't|could|will|won't|would|should|need|needs|check|look|pull|read|reads|diff|compare|run|runs|ran|find|found|work|works|go|goes|start|dig|see|map|trace|test|write|pass|passes|fail|fails|pick|picks|keep|keeps|use|uses|handle|handles|get|gets|got|show|shows|take|takes|make|makes|stay|stays|lives|sits|holds|\w+ed|\w+ing)\b/i;
/** A bullet's text with no list or task marker. */
const item = line => line.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]*)?/, "").trim();
/** A bullet that is a bare topic label, such as `- git` or `- instructions`: one to three words, no verb; an empty task box counts too. */
export const bareLabel = line => {
  if (!BULLET.test(line)) return false;
  const text = item(line).replace(/[:.]$/, "");
  return !text || (text.split(/\s+/).length <= 3 && !VERB.test(text));
};
/** A word that makes a short line with no verb a verdict, such as "All clear to ship." or "Not yet, two are red." */
const VERDICT = /\b(yes|no|yep|nope|not|none|nothing|clear|clean|fine|good|ready|safe|ok|okay|broken|red|green|live|up|down)\b/i;
/** A short line is a sentence when it ends like one, says a verb or a verdict and does not open on what the agent is doing. */
const shortAnswer = line => words(line) >= 2 && /[.!?]$/.test(line) && (VERB.test(line) || VERDICT.test(line)) && !/^\W*\w+ing\b/i.test(line);
/**
 * A natural opening line for the place: a sentence with a verb, no `label:` opener and no ack such as "on it" or "Working on it." A line
 * of five words or more needs only the verb. A shorter one is the answer in a plain sentence, which the owner asks for first, as "yes, all
 * three are running." opens the post he praised and "Yes, it's on main." answers a quick ask: it passes when it ends as a sentence and
 * says a verb or a verdict. On 11-23 the 17:41 KST checklist run opened "All clear to ship." and failed here for its 4 words alone. A
 * title such as "four pre-ship checks" and a progress line such as "checking all four now", both from 11-20 runs, still fail.
 */
export const naturalLine = line => !BULLET.test(line) && (words(line) >= 5 ? VERB.test(line) : shortAnswer(line)) && !/^[^:\n]{1,25}:\s*\S/.test(line) && !/^\W*(?:on it|working on it|got it)\b/i.test(line);
/**
 * Whether a post's first line calls everything clear while a line under it counts uncommitted files, as the 17:41 KST checklist run of
 * 11-23 did: "All clear to ship." over "7 tracked files have uncommitted edits ... There are also 8 untracked paths". The other 6
 * answered runs of that ask since 11-22 named the files in the answer, such as "Three of the four are clear, but 15 files are uncommitted".
 * A negated line says the opposite, as the 11-24 hand run's "Not ready to ship yet." over its 66 uncommitted entries did.
 */
export const overstates = text => {
  const [first = "", ...rest] = text.split("\n").filter(line => line.trim());
  const clear = /\b(all (?:\w+ ){0,3}?(?:clear|clean|good|fine|green)|(?:good|clear|ready|safe) to (?:go|ship)|nothing (?:blocks|is blocking|to fix)|no blockers?)\b/i.test(first) && !/\b(but|except|apart from|other than|aside from|though|besides|not|never)\b|n't\b/i.test(first);
  return clear && rest.some(line => /\b[1-9]\d*\b[^.\n]*\buncommitted\b|\buncommitted\b[^.\n]*\b[1-9]\d*\b/i.test(line));
};
/**
 * The sentences of each line of a text, with code and link targets left out. A wall of text, such as dm_agent-factory p55 on 11-21, a
 * paragraph of the guess, the cause, the plan and the pick, holds 3 or more on one line.
 */
export const lineSentences = text => text.replace(/```[\s\S]*?```/g, "").split("\n").filter(line => line.trim()).map(line => lineParts(item(line)).length);
/** Words that state the agent's own pick, such as "I'd plan around ..." in an after run on 11-21. */
const PICK = /\b(i'd|my pick|i'll|i'm going|i suggest|suggest|recommend|unless you'd rather|i lean|lean toward|my vote|going with|default to)\b/i;
/** Whether every question in a text comes with a pick in or before the paragraph that asks it; code, links and URLs hold no question. */
export const pickFirst = text => {
  const clean = text.replace(/```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)|https?:\/\/\S+/g, " ");
  const at = clean.indexOf("?");
  if (at < 0) return true;
  const end = clean.indexOf("\n\n", at);
  return PICK.test(clean.slice(0, end < 0 ? clean.length : end));
};
const OPEN = /^\s*[-*+] \[ \] /m;
/**
 * A first reply that narrates the agent's own plan, such as #sw-factory-build p158 "I'll map how it really works first, then write one
 * proposal with options and my pick. It will cover these:", which the owner answered in p159 (msg mwqwjznm, c234): "이런건 내부적으론 알아서
 * 하고, 밖에서 보낼땐 slop slop slop fucking disgusting try again". Saying what he will get, such as "I'll come back with a before and after",
 * stays fine.
 */
const NARRATION = /\b(?:i'll\b[^.\n]*\bfirst\b|first,? i(?:'ll| will)\b|(?:then|next|after that),? i(?:'ll| will)\b|here's what i(?:'m| am|'ll| will)\b|what i'm (?:checking|doing|looking at)|it will cover|will cover these|i'm going to|i(?:'ll| will) (?:check|look|read|dig|map|trace|go through|start|confirm|verify|research|run|investigate|explore)\b|let me (?:check|look|start|first)|my plan is)/i;

/** Whether a first reply narrates the agent's own plan, with code spans left out. */
export const narrates = text => NARRATION.test(text.replace(/```[\s\S]*?```|`[^`\n]*`/g, " "));
/** Whether a text holds an open `- [ ]` item, a process step with no result yet. */
export const hasOpenItem = text => OPEN.test(text);

/**
 * The natural checks for an ask's answer posts, given each post's versions in order (`[[first, ...edits], ...]`). The first version gives
 * the answer or says in one plain line what the owner will get, with no plan of the agent's own and no open `- [ ]` process items (c234);
 * a ticked or plain list of results is fine.
 */
export function naturalChecks(postVersions) {
  const all = postVersions.flat();
  const first = postVersions[0] ?? [];
  const firstLine = (first[0] ?? "").split("\n").find(line => line.trim())?.trim() ?? "";
  const last = first.at(-1) ?? "";
  const counts = lineSentences(last);
  return [
    ["the first post opens with a natural sentence", naturalLine(firstLine)],
    ["the first version narrates no plan of the agent's own", !narrates(first[0] ?? "")],
    ["the first version holds no open - [ ] item", !hasOpenItem(first[0] ?? "")],
    ["no version holds a bare topic label bullet", all.every(text => !text.split("\n").some(bareLabel))],
    ["every question comes with the agent's pick", all.every(pickFirst)],
    ["no line of any version holds 3 or more sentences", all.every(text => lineSentences(text).every(n => n < 3))],
    // The first post's last version, since a later post is often a one-line question; 35 words is config/AGENTS.md rule 5's sentence cap.
    ["the first post's last version opens with a line of at most 2 sentences", counts.length > 0 && counts[0] <= 2 && words(last.split("\n")[0]) <= 35],
  ];
}
