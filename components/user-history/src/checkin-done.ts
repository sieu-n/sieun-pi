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
 * name ("2030-email-from-shipped/assets").
 */
const SAYS_SHIPPED = new RegExp(String.raw`(?<!\b(?:not|until|after|once|before|when|if|be|awaiting|for|on|nothing|no|never|without|yet|pending)\s+(?:\w+\s+){0,3})` +
  String.raw`(?<![-/.])\b(?:(?<!\b(?:the|this|that|these|those|our|its|their|from|of)\s+)(?:shipped|merged|deployed|landed|released)\b(?![-/.]\w)|` +
  String.raw`(?:is|are|now|went|already)\s+live|live\s+on\s+(?:prod|production|staging|main))\b`, "i");
/** A waitFor on the owner: a For you todo id (t41) or the owner's go, answer or pick. */
const OWNER_WAIT = /\bt\d+\b|\bowner'?s?\b/i;
/** A waitFor on the work reaching users: a land, deploy, release, merge, promote, push or ship, staging or production. */
const SHIP_WAIT = /\b(?:land(?:s|ed|ing)?|deploy\w*|releas\w*|merg\w*|promot\w*|push\w*|ship\w*|staging|prod|production|live)\b/i;
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
  const said = SAYS_SHIPPED.exec(claimWords(item.note ?? "", item.job));
  return said ? `its note says "${said[0]}"` : null;
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
