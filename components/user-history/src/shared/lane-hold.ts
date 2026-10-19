import type { BoardOp } from "./types.ts";

/**
 * A plan step that holds work at a level until a land, deploy, promote or fix (c72, c100). The rule held only as text, and it did not hold: on
 * 10-15 21:46Z the Crawler VP wrote "census holds at 96 until the land 39 write cuts (0150 side table, ClickHouse linger) are live" on p23,
 * blaming metal's IO stop line, and the owner answered "blockered in nvme IOPS??? you kidding??" (c72 repeat). The fix was a global prompt
 * note, which a chat sees only as one line of a six-entry digest, and the chat wrote "Census holds 128 slots until land 37" on 10-16 08:39Z,
 * 10-17 21:16Z and 21:36Z, until the owner wrote "씨발 그러면 높여야될거 아니니????? ... 안되는 이유가 뭔데" on 10-18 02:13Z (c100).
 */
const ACTIVE = "hold|holds|held|holding|keep|keeps|kept|keeping|park|parks|parked|pin|pins|pinned";
/** "Prod stays at 0 until the next promote ships the new code" is a reading, so a stay, sit or remain needs a setting's unit after the number. */
const PASSIVE = "stay|stays|stayed|staying|sit|sits|sat|sitting|remain|remains|remained";
const UNIT = "slots?|workers?|threads?|tasks?|jobs?|connections?|reads?|pages?|accounts?|profiles?|requests?|calls?|(?:a|an|per)\\s+(?:second|minute|hour|day)|" +
  "rps|qps|MB/s|Mbps|concurrency";
const WAIT = "until|till|pending|for|before";
const FIX = "lands?|landing|land \\d+|deploys?|promotes?|promote \\d+|release|fix(?:es)?|write cuts?|cutover|merges?|merged|reviews?|reviewed";
const GAP = (count: number, chars = "\\p{L}'-"): string => `(?:\\s+(?!(?:${WAIT})\\b)[${chars}]+){0,${count}}?`;
const LEVEL = "\\s+(?:at\\s+|to\\s+|on\\s+)?(?:about\\s+|~)?\\d[\\d,.]*\\s*[kKmM%]?";
const UNTIL = `\\s+(?:${WAIT})\\b(?:\\s+\\S+){0,4}?\\s+(?:${FIX})\\b`;
const HOLD = new RegExp([
  `\\b(?:${ACTIVE})\\b${GAP(2)}${LEVEL}${GAP(3, "\\p{L}/'-")}${UNTIL}`,
  `\\b(?:${PASSIVE})\\b${GAP(2)}${LEVEL}\\s*(?:${UNIT})\\b${GAP(2, "\\p{L}/'-")}${UNTIL}`,
].join("|"), "iu");
/** "Census stops holding at 128 slots for land 37 and steps up" (p364, 10-18 02:14Z) ends a hold. */
const ENDED = /(?:\bstop(?:s|ped)?|\bno longer|\bnever|\bnot|n't|\bdon't|\bwon't)\s+$/iu;
const SENTENCE = /(?<=[.!?;])\s+/;
const CODE = /`[^`]*`/g;
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;

const clip = (text: string, max = 70): string => text.length > max ? text.slice(0, max - 1).trimEnd() + "\u2026" : text;

/** Each sentence of plan text, note or wait that holds work at a level until a land or fix, clipped to quote. */
export function laneHolds(ops: readonly BoardOp[]): string[] {
  const texts = (op: BoardOp): unknown[] => {
    if (op.op === "plan_add") return [op.text, op.waitFor];
    if (op.op === "plan_update") return [op.text, op.note, op.waitFor];
    if (op.op === "plan_set") return op.items.flatMap(function items(item): unknown[] { return [item.text, item.note, item.waitFor, ...(item.children ?? []).flatMap(items)]; });
    return [];
  };
  return ops.flatMap(texts).flatMap(text => typeof text === "string" ? text.replace(CODE, " ").replace(QUOTED, " ").split(SENTENCE) : []).flatMap(sentence => {
    const hold = HOLD.exec(sentence);
    return hold && !ENDED.test(sentence.slice(0, hold.index)) ? [`"${clip(sentence.slice(hold.index).trim())}"`] : [];
  });
}

/** The chat_board flag for a step that holds work until a land or fix, or null. The ops are saved either way (soft, c98). */
export function laneHoldFlag(ops: readonly BoardOp[]): string | null {
  const holds = laneHolds(ops);
  return holds.length ? `Saved, but a plan step holds work at a level until a land or fix ${holds.join(", ")} (c72, c100). Raise it now in measured ` +
    "steps instead, judge each step by total good reads over about 15 minutes, and step back only on a harm you measured, named with numbers. " +
    "A stop or pressure line another chat set is a cautious setting too: ask its owner what measured harm it prevents, and raise or remove it " +
    "when there is none. While the fix rides its land, work on what else moves the goal. Reword the step with plan_update." : null;
}
