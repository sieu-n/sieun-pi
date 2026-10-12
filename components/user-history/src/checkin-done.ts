import type { ChatBoard, PlanItem, PlanStatus } from "./shared/types.ts";

/*
 * The check-in's "looks done" test (`finished_open`), split out of src/chat-checkin.ts, which is over the 1,000-line limit.
 */

const OPEN: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);
const CLOSED: ReadonlySet<PlanStatus> = new Set(["done", "dropped"]);

/** A path or a dated folder name ("sessions/2026/10/09/1952-thread-job-split-audit"): its words claim nothing (p168 matched "thread" in one). */
export const pathLike = (token: string): boolean => token.includes("/") || /^\d{4}-[a-z0-9-]+$/i.test(token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
/**
 * A note that says the work shipped: shipped, merged, deployed, landed, released, or live (is live, now live, live on production), unless a
 * word up to three words before it, in the same clause, makes it a condition, a wait or a denial ("not merged", "after it is deployed",
 * "until landed", "to be released", "nothing deployed"), or the word right before it makes it a name or an adjective ("the shipped app",
 * "built from Shipped": frontend bro 10-12, p84, p92 and p96). A word joined to it by a hyphen, a slash or a dot is part of a path or a
 * name ("2030-email-from-shipped/assets"). Parts merged into one version are one build, not a merged PR (frontend bro 10-13, p92). A released
 * queue, hold or lock frees other work and ships nothing ("Fable released the queue": AI harness 10-13, p319).
 */
const SAYS_SHIPPED = new RegExp(String.raw`(?<!\b(?:not|until|after|once|before|when|if|be|awaiting|for|on|nothing|no|never|without|yet|pending)\s+(?:\w+\s+){0,3})` +
  String.raw`(?<![-/.])\b(?:(?<!\b(?:the|this|that|these|those|our|its|their|from|of)\s+)(?:shipped|merged|deployed|landed|released)\b(?![-/.]\w)` +
  String.raw`(?!(?<=merged)\s+into\s+(?:one|a|a\s+single)\b)(?!(?<=released)\s+(?:the\s+|its\s+|their\s+|a\s+)?(?:\w+\s+)?(?:queue|hold|lock)s?\b)|` +
  String.raw`(?:is|are|now|went|already)\s+live|live\s+on\s+(?:prod|production|staging|main))\b`, "i");
/** A waitFor on the owner: a For you todo id (t41) or the owner's go, answer or pick. */
const OWNER_WAIT = /\bt\d+\b|\bowner'?s?\b/i;
/** A waitFor on the work reaching users: a land, deploy, release, merge, promote, push or ship, staging or production. */
const SHIP_WAIT = /\b(?:land(?:s|ed|ing)?|deploy\w*|releas\w*|merg\w*|promot\w*|push\w*|ship\w*|staging|prod|production|live)\b/i;
/** A run or a push still on its way: dispatched, queued, running (or rerunning), in flight or in progress (launch main bro 10-12: p68 waited for "promote 8 run 38267006888 (dispatched 15:00:06Z)";
 * AI harness 10-13: p319's run "is rerunning with its same id"). */
const IN_FLIGHT = /\b(?:(?:re-?)?(?:dispatched|queued|running)|in\s+flight|in\s+progress)\b/i;
/** A line in the note that lists the work still to do or says the item is not done (launch main bro 10-12: p54 "Board 39 is live ... Left to do: ...";
 * frontend bro 10-13: p92 "Not done yet. ... Next the job fixes ..."). */
const LEFT_TO_DO = /\bleft(?:\s+to\s+do\b|\s*:)|\bnot\s+(?:yet\s+)?(?:done|finished)\b|(?:^|[.;!?]\s+)next\s+the\s+job\b/i;
/** The words that name what a ship claim or a wait is about: 3 letters or more, without the ship words and small words. */
const SUBJECT_SKIP = new Set(["the", "and", "then", "with", "for", "from", "after", "about", "its", "his", "her", "our", "this", "that", "their", "is", "are", "now", "went",
  "already", "live", "shipped", "merged", "deployed", "landed", "released", "staging", "prod", "production", "main", "run", "until", "once", "when"]);
const subjectWords = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[\p{L}][\p{L}\p{N}]{2,}/gu) ?? []).filter(word => !SUBJECT_SKIP.has(word)));
/** The words of a note that can claim a ship: its paths, dated folder names and the item's own job name taken out. */
function claimWords(note: string, job: string | undefined): string {
  const words = note.split(/\s+/).filter(token => !pathLike(token)).join(" ");
  const name = job?.trim();
  return name && !/^[0-9a-f]{8}-/i.test(name) ? words.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ") : words;
}
/**
 * Why an open plan item looks done, or null: every item under it is closed and it waits for nothing, or its note says it shipped
 * (SAYS_SHIPPED). The check-in then lists it for a check against the real state (dev env VP 10-09: a goal stayed open after it was live on
 * production).
 */
export function looksDone(item: Pick<PlanItem, "status" | "note" | "children" | "waitFor"> & Partial<Pick<PlanItem, "job">>): string | null {
  if (!OPEN.has(item.status)) return null;
  const wait = item.waitFor?.trim() ?? "";
  // An item that waits on the owner's answer is not done, whatever its steps or note say (VP of CI 10-12: p41's steps were all done and its
  // build waited on the owner's ok on t26; it was flagged in every run).
  if (OWNER_WAIT.test(wait)) return null;
  // Closed steps under an item that still waits are its first part: its own work comes after the wait (VP of CI 10-12: p19 waits on the land
  // 33 chain push, 3 runs; launch main bro 10-12: p27's rate test waits on a GO line, 4 runs; each check-in kept it open). The wait's own
  // checks (stalled_steps, wait_met, blocked_on_others) push it.
  if (!wait && item.children.length > 0 && item.children.every(child => CLOSED.has(child.status))) return "every step under it is closed";
  // A note names shipped parts of work that is still open: an open step under the item, or a wait on the owner's answer (AI harness 10-12:
  // p254 "...are live" with p268 open, p288 waiting on t41; 7 of 9 flags were false and jobs reworded notes to dodge the match). A wait on a
  // deploy or a land stays listed: a note that says it shipped may mean the wait is over. Any other wait names the item's own next work
  // (Crawler VP 10-12: p115 "Watch v8 is live" waited for its own ci ref).
  if (item.children.some(child => OPEN.has(child.status))) return null;
  if (wait && !SHIP_WAIT.test(wait)) return null;
  // A note that lists work left, or a run still on its way in the wait or the note, says the item is not done yet (launch main bro 10-12:
  // p54 "Board 39 is live ... Left to do: ...", p68 waited for promote 8 "(dispatched 15:00:06Z)"; each was flagged twice and kept open).
  const note = item.note ?? "";
  if (LEFT_TO_DO.test(note) || IN_FLIGHT.test(wait) || IN_FLIGHT.test(note)) return null;
  // With a ship wait, only a claim about the waited thing may mean the wait is over: "PROBE A deployed" for a wait on PROBE A counts, and
  // "Obs is deployed" for a wait on promote 8 is another service (launch main bro 10-12, p68).
  const waited = subjectWords(wait);
  for (const sentence of claimWords(note, item.job).split(/(?<=[.;!?])\s+/)) {
    const said = SAYS_SHIPPED.exec(sentence);
    if (said && (!wait || [...subjectWords(sentence)].some(word => waited.has(word)))) return `its note says "${said[0]}"`;
  }
  return null;
}
/** Every open plan item that looks done (`looksDone`), steps before the goal above them. */
export function finishedOpen(board: ChatBoard | null): { item: PlanItem; reason: string }[] {
  const found: { item: PlanItem; reason: string }[] = [];
  const visit = (item: PlanItem) => {
    item.children.forEach(visit);
    const reason = looksDone(item);
    if (reason) found.push({ item, reason });
  };
  (board?.plan ?? []).forEach(visit);
  return found;
}
