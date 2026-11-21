/**
 * The checks of blind-replies.mjs `--set natural`, kept apart so natural-checks.test.mjs can run them on real posts. The owner asked in
 * dm_agent-factory p54 on 11-21 (msg mwqt6ry1): "todo를 리스트하는건 좋은데, 자연스럽게 해야지 메시지면 메시지 context에 맞게, channel 도중이면
 * channel message concept에 맞게. 그리고 follow-up question 물어도 돼 괜찮아 대신 primary suggestion은 꼭 두고", and in p57 (msg mwqtjlth):
 * "이런것도 엔터, bullet point 똑바로 쓰고". He praised a DM reply of an answer line, a short paragraph, a lead-in line, bullets and a closing
 * line (msg mwqtp2l1: "정말 훌륭한 메시지였어"), which natural-checks.test.mjs keeps as the target shape.
 */

/** A text's words as tell_owner's long check counts them (reply-lint.ts `longReply`), with no list or task marker counted. */
export const words = text => text.replace(/\]\([^)]*\)/g, "]").replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "").split(/\s+/).filter(Boolean).length;
const BULLET = /^\s*[-*+] /;
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
/** A natural opening line for the place: five words or more with a verb, no `label:` opener and no ack such as "on it" or "Working on it." */
export const naturalLine = line => !BULLET.test(line) && words(line) >= 5 && VERB.test(line) && !/^[^:\n]{1,25}:\s*\S/.test(line) && !/^\W*(?:on it|working on it|got it)\b/i.test(line);
/**
 * The sentences of each line of a text, with code and link targets left out. A wall of text, such as dm_agent-factory p55 on 11-21, a
 * paragraph of the guess, the cause, the plan and the pick, holds 3 or more on one line.
 */
export const lineSentences = text => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`|\]\([^)]*\)/g, "x").split("\n").filter(line => line.trim())
  .map(line => item(line).split(/(?<=[.!?])\s+/).filter(part => /\w/.test(part)).length);
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
const OPEN = /^\s*[-*+] \[ \] \S/gm;
const TICKED = /^\s*[-*+] \[[xX]\] /m;

/**
 * The natural checks for an ask's answer posts, given each post's versions in order (`[[first, ...edits], ...]`). Items may be plain
 * bullets or tasks; open tasks in the first post must be ticked by a later edit of it.
 */
export function naturalChecks(postVersions) {
  const all = postVersions.flat();
  const first = postVersions[0] ?? [];
  const firstLine = (first[0] ?? "").split("\n").find(line => line.trim())?.trim() ?? "";
  const open = (first[0]?.match(OPEN) ?? []).length;
  const last = first.at(-1) ?? "";
  const counts = lineSentences(last);
  return [
    ["the first post opens with a natural sentence", naturalLine(firstLine)],
    ["the first post lists its points or steps as 2 or more bullets", (first[0] ?? "").split("\n").filter(line => BULLET.test(line)).length >= 2],
    ["no version holds a bare topic label bullet", all.every(text => !text.split("\n").some(bareLabel))],
    ["open tasks in the first post get ticked by a later edit", open === 0 || first.slice(1).some(text => TICKED.test(text))],
    ["every question comes with the agent's pick", all.every(pickFirst)],
    ["no line of any version holds 3 or more sentences", all.every(text => lineSentences(text).every(n => n < 3))],
    // The checklist post's last version, since a later post is often a one-line question; 35 words is config/AGENTS.md rule 5's sentence cap.
    ["the first post's last version opens with a line of at most 2 sentences", counts.length > 0 && counts[0] <= 2 && words(last.split("\n")[0]) <= 35],
  ];
}
