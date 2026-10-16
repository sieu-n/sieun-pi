import { mergedPrs, mergeStep, prNumbers } from "./shared/chat-board.ts";
import type { DutyRunRecord } from "./shared/chat-duties.ts";
import { sessionBornAt } from "./shared/duty-fixes.ts";
import { effectiveRun } from "./shared/duty-streak.ts";
import type { ChatBoard, PlanItem, PlanStatus } from "./shared/types.ts";

/*
 * The check-in's "looks done" test (`finished_open`), split out of src/chat-checkin.ts, which is over the 1,000-line limit.
 */

const OPEN: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);

/** A path or a dated folder name ("sessions/2026/10/09/1952-thread-job-split-audit"): its words claim nothing (p168 matched "thread" in one). */
export const pathLike = (token: string): boolean => token.includes("/") || /^\d{4}-[a-z0-9-]+$/i.test(token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
/**
 * A note that says the work shipped: shipped, merged, deployed, landed, released, or live (is live, now live, live on production), unless a
 * word up to three words before it, in the same clause, makes it a condition, a wait or a denial ("not merged", "after it is deployed",
 * "until landed", "to be released", "nothing deployed", "none of them has landed", "hasn't merged": ops guy 10-16, p258), or the word right
 * before it makes it a name or an adjective ("the shipped app", "built from Shipped": frontend bro 10-12, p84, p92 and p96). A word joined to it by a hyphen, a slash or a dot is part of a path or a
 * name ("2030-email-from-shipped/assets"). Parts merged into one version are one build, not a merged PR (frontend bro 10-13, p92). A released
 * queue, hold or lock frees other work and ships nothing ("Fable released the queue": AI harness 10-13, p319). A quoted ship word, or one
 * after "after" and another actor's name, is someone else's act ("After Fable's 'released' at 09:43Z": AI harness 10-13, p357). A check
 * verb before it names a check ("checks each fix job is live"), and a job, session, worker or thread that is live is running, not shipped
 * (AI harness 10-15, p456). A count right before it counts other things that shipped ("so 738 landed in a day": Crawler VP 10-15, p504 to p506).
 */
const SAYS_SHIPPED = new RegExp(String.raw`(?<!\b(?:not|\w+n['’]t|until|after|once|before|when|if|be|awaiting|for|on|nothing|none(?:\s+of(?:\s+[\w'’]+){0,3})?|neither|nor|no|never|without|yet|pending|` +
  String.raw`checks?|checking|verify|verifies|verifying|confirms?|confirming|whether)\s+(?:[\w'’]+\s+){0,3})` +
  String.raw`(?<![-/.'"‘“])\b(?:(?<!\b(?:the|this|that|these|those|our|its|their|from|of)\s+)(?<!(?<![\w.#]|\b(?:land|promote|board|part|cut|wave|phase|tier|round|attempt|release|run|pr|step|item|to|and|or|through)s?\s+#?)\d{1,3}(?:,\d{3})*\s+)(?:shipped|merged|deployed|landed|released)\b(?![-/.]\w)` +
  String.raw`(?!(?<=merged)\s+into\s+(?:one|a|a\s+single)\b)(?!(?<=released)\s+(?:the\s+|its\s+|their\s+|a\s+)?(?:\w+\s+)?(?:queue|hold|lock)s?\b)|` +
  String.raw`(?<!\b(?:jobs?|sessions?|workers?|agents?|child|children|threads?|process(?:es)?)\s+)(?:is|are|now|went|already)\s+live|` +
  String.raw`live\s+on\s+(?:prod|production|staging|main))\b`, "i");
/** A run or a push still on its way: dispatched, queued, running (or rerunning), in flight or in progress (launch main bro 10-12: p68 waited for "promote 8 run 38267006888 (dispatched 15:00:06Z)";
 * AI harness 10-13: p319's run "is rerunning with its same id"). */
const IN_FLIGHT = /\b(?:(?:re-?)?(?:dispatched|queued|running)|in\s+flight|in\s+progress)\b/i;
/** A line in the note that lists the work still to do or says the item is not done (launch main bro 10-12: p54 "Board 39 is live ... Left to do: ...";
 * frontend bro 10-13: p92 "Not done yet. ... Next the job fixes ..."), or names work still red, missed or open (AI harness 10-15: p454 "Parts 1 to
 * 5 shipped, but 16 duties ... still missed 3+ runs", p455 "d1, d4 and d6 are still red"). */
const LEFT_TO_DO = /\bleft(?:\s+to\s+do\b|\s*:)|\bnot\s+(?:yet\s+)?(?:done|finished)\b|(?:^|[.;!?]\s+)next\s+the\s+job\b|\bstill\s+(?:red|open|miss(?:ed|es|ing)?|broken|stuck|unfixed|not)\b/i;
/** A note that reports a run or a check as green, passed or succeeded, and not "not green", "on green" or "once it goes green" (AI harness
 * 10-13: p357 "The job CAS-lands the 7 files on green" while its run was queued). */
const GREEN = /(?<!\bnot\s+(?:yet\s+)?|\bon\s+|\b(?:until|once|when|if|unless|awaiting|pending)\s+(?:[\w'’-]+\s+){0,3})\b(?:green|passed|succeeded)\b/i;
/** The words of a note that can claim a ship: its paths, dated folder names and the item's own job name taken out. */
function claimWords(note: string, job: string | undefined): string {
  const words = note.split(/\s+/).filter(token => !pathLike(token)).join(" ");
  const name = job?.trim();
  return name && !/^[0-9a-f]{8}-/i.test(name) ? words.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ") : words;
}
/** A PR's state on GitHub; `mergedAt` (ms) once it merged. */
export interface PrState { state: "merged" | "open" | "closed"; mergedAt?: number }
/**
 * What the check-in knows outside the board when it asks whether an item is done: each duty metric's verdict on its duty's newest measured
 * run (`metricFacts`, keyed `<dutyId>/<metricKey>` like a step's `duty`), and the state of each PR the board names (`prNumbers`), by number.
 * A PR or metric that is missing is unknown, and unknown is not done.
 */
export interface DoneFacts {
  metrics: ReadonlyMap<string, MetricFact>;
  prs: ReadonlyMap<string, PrState>;
}
export const NO_FACTS: DoneFacts = { metrics: new Map(), prs: new Map() };

/** A duty metric's verdict on a run, with its value and target, which a goal with no target of its own reads as its number (`goalNumber`). */
export interface MetricFact { met: boolean; at: number; value?: number; target?: number; op?: ">=" | "<=" }
/** Each duty metric's verdict on the newest measured run of its duty that has it (`effectiveRun`), from runs newest first. */
export function metricFacts(runs: readonly DutyRunRecord[]): Map<string, MetricFact> {
  const facts = new Map<string, MetricFact>();
  for (const run of runs) {
    const judged = effectiveRun(run);
    if (judged.verdict !== "met" && judged.verdict !== "missed") continue;
    for (const [key, result] of Object.entries(judged.metrics)) {
      const link = `${run.duty}/${key}`;
      if (!facts.has(link)) facts.set(link, { met: result.met, at: run.after?.at ?? run.at, value: result.value, target: result.target, op: result.op });
    }
  }
  return facts;
}

/** Why an open item looks done, and since when (ms): the fact that made it done. */
export interface DoneReason { reason: string; at: number }
/**
 * Why an open plan item looks done, or null. Only facts count, never the words of a note: a step that fixes a duty metric (`duty`) is done when
 * that metric meets its target on the duty's last run, and a merge step (`mergeStep`) when GitHub shows every PR its text names merged. Any other
 * item is done when the chat or its job says so. On 10-16 all 7 items the check-in flagged on 4 chats were open work: notes said "is live" or
 * "merged" about a part (launch main bro p75, slack green guy p71, AI harness p484 and p490), or every step under a goal was closed while its
 * metric missed or its work moved to another chat (launch main bro p125, slack green guy p147, Crawler VP p191). A goal's own `target` does
 * not count: it has no direction, and launch main bro p127 (error reads, 32.4% for a 5% target) and VP of CI p1 (157.8 min for a 10 min wait)
 * are lower-is-better targets that a ratio would read as met. A step that only names merged PRs is not a merge step: slack green guy p82
 * launches the tests that #229 to #249 merged, and their merge is where it starts. A metric reading taken before the step's job began says
 * nothing about the fix: frontend bro p174 makes d1/walk_problems count server outside calls and 5xx pages, and the metric read 0 on the
 * 10-15 21:04Z run, before the step and its job (born 10-16 00:36Z) existed.
 */
export function looksDone(item: Pick<PlanItem, "status" | "text"> & Partial<Pick<PlanItem, "duty" | "waitFor" | "note" | "job" | "sessionId">>, facts: DoneFacts): DoneReason | null {
  if (!OPEN.has(item.status)) return null;
  // A step the board refuses to close on its own note is not done (ops guy 10-16, p254: d1/servers_not_answering read 0 while the step waited
  // for eecd9d7d5b to land, which never reached sieun/dev, and 3 check-ins in a row said "close it").
  if (unlandedClose(item, { ...item, status: "done" })) return null;
  if (item.duty) {
    const fact = facts.metrics.get(item.duty);
    const jobBorn = item.sessionId ? sessionBornAt(item.sessionId) : null;
    if (jobBorn !== null && fact && fact.at < jobBorn) return null;
    return fact?.met ? { reason: `its metric ${item.duty} is met on the duty's last run`, at: fact.at } : null;
  }
  const prs = mergeStep(item.text) ? mergedPrs(item.text) : [];
  const states = prs.map(pr => facts.prs.get(pr));
  if (!prs.length || !states.every(state => state?.state === "merged")) return null;
  return { reason: `${prs.map(pr => `#${pr}`).join(", ")} ${prs.length > 1 ? "are" : "is"} merged`, at: Math.max(...states.map(state => state?.mergedAt ?? 0)) };
}
/** Every open plan item that looks done (`looksDone`), steps before the goal above them. */
export function finishedOpen(board: ChatBoard | null, facts: DoneFacts): ({ item: PlanItem } & DoneReason)[] {
  const found: ({ item: PlanItem } & DoneReason)[] = [];
  const visit = (item: PlanItem) => {
    item.children.forEach(visit);
    const done = looksDone(item, facts);
    if (done) found.push({ item, ...done });
  };
  (board?.plan ?? []).forEach(visit);
  return found;
}
/** The PR numbers the open items of a board name in their text or note: the ones whose state the check-in reads. */
export function boardPrs(board: ChatBoard | null): string[] {
  const prs = new Set<string>();
  const visit = (item: PlanItem) => {
    if (OPEN.has(item.status)) for (const pr of prNumbers(`${item.text}\n${item.note ?? ""}`)) prs.add(pr);
    item.children.forEach(visit);
  };
  (board?.plan ?? []).forEach(visit);
  return [...prs];
}

/**
 * A CI run, a probe, a land or a push named in a wait or a note. A run is a CI run only by its id or a CI word before it, so "18 not yet run"
 * rows and a duty that "runs daily" are no run (launch main bro 10-13 p43, AI harness 10-13 p1).
 */
const SHIP_WORK = /\b(?:probes?|land(?:s|ed|ing)?|push(?:es|ed|ing)?|verify-dev)\b|\bci\/|\b(?:ci|air|guard|candidate|workflow|fresh|re-?)\s*runs?\b|\bruns?\s+\d{8,}|\b\d{8,}\b/i;
/** A wait on a land or a push: it is over only when a note names the landed commit. */
const LAND_WAIT = /\b(?:land(?:s|ed|ing)?|push(?:es|ed|ing)?)\b/i;
/** A sentence that leaves the run, the land or the push to later or to another session: on its way, on green, handed to or owned by another thread. */
const NOT_YET = new RegExp(String.raw`\b(?:still|not\s+yet|(?:goes|go)\s+green|on\s+green|waits?\s+(?:for|on)|until|will|hand(?:s|ed)?\s+(?:it\s+)?(?:off\s+)?to|` +
  String.raw`moved\s+to|takes?\s+over|owns?\s+(?:the\s+|its\s+)?(?:[\w'’-]+\s+){0,2}(?:land|lands|push|pushes|run|runs|probe)|reports?\s+back|lands\s+it|to\s+land)\b`, "i");
const SHA = /(?<![\w/.-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w/-])/i;
/** A commit said to be on a shared branch ("on sieun/dev as c839950e5c", "in land 33 on origin/staging (f9f3a0f1c6)"). */
const ON_BRANCH = /\b(?:on|in|into|to)\s+(?:local\s+)?(?:origin\/[\w/-]+|sieun\/dev|main|staging|prod(?:uction)?)\b/i;
/** A sentence without its quotes and asides: "the owner answered t45 with 'Not yet'" and "(freeze, probe, wait for verify-dev, commit on green)" name no wait of the step. */
const plainWords = (sentence: string): string => sentence.replace(/(['"‘“])[^'"’”]*['"’”]|\([^()]*\)/g, " ");

/**
 * Why closing this step now would be early, or null. `looksDone` reads it, so the check-in never calls a step done while its run, probe, land
 * or push has not finished green and landed (AI harness 10-14 17:01 KST: notes said "Its verify-dev run 38529531177 was still queued"). A
 * sentence of the note that names such work still on its way, on green, or handed to another session counts, and so does a wait on a land or a
 * push whose note names no commit sha that landed or sits on a shared branch, or a wait on a run or a probe whose note reports nothing green.
 * The step's own job name ("skill rules land") is no land.
 */
export function unlandedClose(before: Pick<PlanItem, "status" | "waitFor">, after: Pick<PlanItem, "status" | "waitFor" | "note" | "job">): string | null {
  if (after.status !== "done" || !OPEN.has(before.status)) return null;
  const note = after.note ?? "";
  const ship = note.split(/(?<=[.;!?])\s+/).map(sentence => ({ sentence, words: plainWords(claimWords(sentence, after.job)) })).filter(({ words }) => SHIP_WORK.test(words));
  const pending = (ship.find(({ words }) => IN_FLIGHT.test(words)) ?? ship.find(({ words }) => NOT_YET.test(words) || LEFT_TO_DO.test(words)))?.sentence;
  if (pending) return `its note says ${quoteText(pending)}`;
  for (const wait of [before.waitFor, after.waitFor]) {
    if (!wait?.trim() || !SHIP_WORK.test(wait)) continue;
    if (LAND_WAIT.test(wait) ? !((SAYS_SHIPPED.test(note) || ON_BRANCH.test(note)) && SHA.test(note)) : !GREEN.test(note)) {
      return `it waits for ${quoteText(wait)} and its note names no ${LAND_WAIT.test(wait) ? "landed commit sha" : "green run"}`;
    }
  }
  return null;
}
const quoteText = (text: string): string => `"${text.trim().length > 160 ? text.trim().slice(0, 159) + "…" : text.trim()}"`;
