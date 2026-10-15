import { dirname, join } from "node:path";
import { clockTime, localTime } from "./checkin-settings.ts";
import type { JobRegistry } from "./chat-sources.ts";
import { MERGE_RULE } from "./shared/chat-board.ts";
import { releaseGo } from "./shared/release-go.ts";
import { type DutyCard, type DutyJobRef, headlineMetric, verdictMetrics } from "./shared/chat-duties.ts";
import { dutyLink } from "./shared/duty-fixes.ts";
import { CHANGE_APPROACH_MISSES, type MetricStreak } from "./shared/duty-streak.ts";
import type { SessionRow } from "./shared/types.ts";

/**
 * Duty jobs: on every scheduled run of a duty (the built-in check-in included) the server starts one job for it, a root session linked to the
 * chat the way a root the chat starts with rlm.create_session is (the job registry, by session id), so it shows in the chat's Agents card, gets
 * the job reply guideline, and reports to the chat. Its brief is the duty, the owner's words and the precheck; the job decides what to check,
 * what to fix and what to start. The server only measures and starts it.
 */

/** The folder that holds scripts/board-apply.ts, the command a duty job applies its board ops with. */
const USER_HISTORY = join(import.meta.dirname, "..");

/** The chat a duty job works for: its session id and name (the job's reply target), its working folder, and its board file. */
export interface DutyChat { id: string; name: string; cwd: string; board: string }
/** What the duty runner needs to start and retire duty jobs; the backend wires it to the thread hub, the catalog and the job registry. */
export interface DutyJobHost {
  /**
   * The chat as a duty job needs it. A chat with no catalog row gets one full list of the daemon's sessions and a second look: null when that
   * list does not show it either, and a rejection when the list fails. After a restart the catalog has no rows until a full list answers
   * (10-12 16:07 to 16:27Z the list timed out at 30 s and 14 duty runs of 7 chats lost their job as "the catalog does not list the chat").
   */
  chat(chatId: string): Promise<DutyChat | null>;
  /** Whether a duty job still works: its own turn, or a subagent below it. False when it is gone. */
  working(job: DutyJobRef): Promise<boolean>;
  /** Starts the job: a new root session named `name` in the chat's folder, registered as the chat's job, with `brief` as its first message. */
  start(chat: DutyChat, name: string, brief: string): Promise<DutyJobRef>;
  /**
   * Drops a finished duty job from the registry, so the chat's Agents card lists only the current one, and queues its archive
   * (src/chat-archive-queue.ts): a slow daemon never holds up the next start.
   */
  retire(job: DutyJobRef): Promise<void>;
  /**
   * The duty jobs to archive now, with one catalog read: each `last` job (its duty's newest) whose turn has ended, listed, not archived, not
   * working, past its brief (2 or more messages) and not settled on a failed model call (the chat's revive restarts those), and each `older` job
   * that is still listed, not archived and not working. A host without it (test fakes) stops no job early.
   */
  ended?(last: readonly DutyJobRef[], older?: readonly DutyJobRef[]): Promise<DutyJobRef[]>;
  /** Queues the archive of an ended duty job, so its worker and Python kernel stop; it stays registered until the next run retires it. */
  stop?(job: DutyJobRef): Promise<void>;
  /** Sends a duty job a message that starts a new turn: the server sends a job back while its run's misses have no fix step with a live job. */
  steer?(job: DutyJobRef, text: string): Promise<void>;
}

/**
 * A duty job's name: the duty's name in lowercase, the chat's name and the start time, like `check-in frontend bro 14:00`. Root sessions share
 * one parent, so a name without the chat collided at the first live tick: 4 of 9 chats got "check-in 01:40 is unavailable" (10-09).
 */
export const dutyJobName = (duty: string, chat: string, at: number): string => {
  const short = chat.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 32).trim();
  return `${duty.trim().toLowerCase()}${short ? " " + short : ""} ${clockTime(at)}`;
};

/** What a duty job's brief holds: the duty, the chat, the job's name and start, the measure against the targets, and the precheck's findings (markdown). */
export interface DutyJobInput {
  duty: Pick<DutyCard, "name" | "ownerWords" | "goal" | "metrics"> & { id?: string; onMiss?: string; boardGoal?: string };
  chat: Pick<DutyChat, "id" | "name" | "board">;
  job: string; at: number; measure: string; findings: string;
  /** What this duty's job looks at besides the generic rules, in the owner's terms. */
  focus?: readonly string[];
  /** The miss streak of each metric this run missed (`metricStreaks`), with the fix step the run found for it. */
  misses?: readonly MetricStreak[];
}

const runs = (count: number): string => `${count} ${count === 1 ? "run" : "runs"}`;
const owner = (fix: NonNullable<MetricStreak["fix"]>): string => fix.job ? `job ${fix.job}` : "no job";

/**
 * One line per missed metric: its streak and what this run must do about it. A metric with a live fix job gets a steer, one with none gets a
 * new fix job, and a stuck one (CHANGE_APPROACH_MISSES misses with no move) gets a new root-cause job that names the fix that did not work.
 */
export function missLine(dutyId: string, streak: MetricStreak, label: string, unit = ""): string {
  const link = JSON.stringify(dutyLink(dutyId, streak.key));
  const where = `${streak.key} (${label}) is ${streak.value}${unit}, target ${streak.op} ${streak.target}${unit}, missed ${runs(streak.misses)} in a row` +
    `${streak.misses > 1 ? streak.moved ? ", moving toward the target" : ", not moving toward the target" : ""}.`;
  const fix = streak.fix;
  if (streak.stuck) {
    return `${where} Change approach: ${fix ? `the fix ${fix.step} (${owner(fix)}) did not move it` : "no fix step moved it"}. Start a new ` +
      "root-cause job with rlm.create_session that finds why the last fix did not move the number and fixes that cause in code. Do not run the " +
      `same fix again. Add its own plan step with duty ${link} and the new job${fix ? `, and close or drop ${fix.step} with a note naming the new step` : ""}.`;
  }
  if (fix?.live) return `${where} Its fix step ${fix.step} has the live job ${fix.job}: steer that job with this number and what the precheck found, and push it to land the code fix.`;
  return `${where} ${fix ? `Its fix step ${fix.step} has ${fix.job ? `no live job (${fix.job} is not at work)` : "no job"}.` : "No plan step fixes it."} Start a fix job with ` +
    "rlm.create_session whose brief is to find the cause and land a code change that moves this number. In the same board change, " +
    `${fix ? `set that job on ${fix.step} if it is still open, else add a plan step` : "add a plan step"} with duty ${link} and that job.`;
}

/** The rules every job the server starts for a chat follows (duty jobs and fix jobs), in brief order. */
function chatJobRules(): string[] {
  return [
    "Two hard gates hold for every chat. A step marked as needing the owner's go moves only after the owner answers its For you todo with a go " +
      "(a step whose only target is staging never needs one): " +
      "never start, steer or report work on it as approved before that, and stop a job that started without it. A Build step starts only after " +
      "its goal's requirements check: a plan or design job's report quotes the original owner request and checks each line of it against the " +
      "design before build.",
    releaseGo.preapproval ? MERGE_RULE : `${MERGE_RULE} A merge step done without that go is a repo rule breach: report it to the owner in your report, with the PR.`,
    "A goal can carry a target: when you measure it, apply plan_update with its whole target, like " +
      "`{\"op\":\"plan_update\",\"id\":\"p1\",\"target\":{\"metric\":\"proxy bandwidth used\",\"target\":200,\"unit\":\"Mbps\",\"current\":8,\"measuredAt\":\"2026-10-09T21:00:00+09:00\",\"source\":\"proxy dashboard, 24 h average\"}}`. " +
      "Close the largest gap first: start or steer the job that moves the number.",
    "Never push a ci/ branch or use --push-ci: build the commit object for auto-sns-agent " +
      "(`node scripts/repo/agent/commit.mjs --object-only -m \"<type>(<scope>): <what>\" <files>`) and send it to the chat, which asks Fable for a probe slot; " +
      "code reaches the shared tip only after its own green probe. Every file you touch stays " +
      "under its light-guard line limit (1,000 lines for most source files); split a file before it would cross it.",
    "Never cancel or rerun an auto-sns-agent CI run (`gh run cancel`, `gh run rerun` or their API calls), yours included; a superseded run is cancelled by " +
      "Fable's loop or its own probe family, so send Fable its id through the chat, and push a fresh run for a new attempt.",
    "Do what you can reach yourself: Convex data is read or written with `npx convex run` or a query using the deploy key and an identity; " +
      "never ask the owner for his browser or to act as him, and turn such a For you todo into a job.",
    "Never send anything outside on your own: an email, a vendor or support ticket reply, a customer message or a public post is drafted and " +
      "put in For you with the draft and choices; it goes out only after the owner approves it there.",
    "Act directly and ship: do not invent waiting rules, extra review rounds or safety gates of your own; keep only the gates the owner asked for.",
    "No cap, throttle, timeout, rate or caution line without a measurement, a vendor limit or an incident cited next to the number; remove unbacked ones.",
  ];
}

/** The board-apply call a job the server starts runs for its board ops, as Python. */
const boardApplyCall = (chat: Pick<DutyChat, "id" | "board">): string =>
  `await bash("cd ${USER_HISTORY} && node --import tsx scripts/board-apply.ts ${chat.id} " + shlex.quote(json.dumps(ops)) + " --data-dir ${dirname(dirname(chat.board))}")`;
/** The report call a job the server starts ends with. */
const reportCall = (chat: Pick<DutyChat, "name">): string => `await agent_message.send(report, receiver_role="sibling", receiver_name=${JSON.stringify(chat.name)})`;

/**
 * The duty job's brief (owner 10-09: "every (n min/h/day) -> code precheck -> run job with that context to 'fix issues, check what duty
 * specifies, be a VP, report to user what needed'"; "control flow should be dynamically defined by agent"): the duty in the owner's words, the
 * precheck as information, and how a chat job works. It names no fixed list of checks and no verdict; a quiet run ends in one short turn.
 */
export function dutyJobBrief({ duty, chat, job, at, measure, findings, focus = [], misses = [] }: DutyJobInput): string {
  const send = reportCall(chat);
  const headline = headlineMetric(duty.metrics);
  const counted = verdictMetrics(duty.metrics);
  const shown = misses.filter(streak => counted.some(metric => metric.key === streak.key));
  const apply = boardApplyCall(chat);
  return [
    `# ${job}: the ${duty.name} duty of the chat "${chat.name}"`,
    `You are the duty job "${job}" of the chat "${chat.name}" (session id ${chat.id}), started ${localTime(at)}. The server starts one duty job ` +
      `on each scheduled run of this duty, with the precheck below as context. Act as the chat's VP for this duty.`,
    "## The duty",
    `Goal: ${duty.goal}`,
    `Owner's words (verbatim):\n\n${duty.ownerWords.split("\n").map(line => `> ${line}`).join("\n")}`,
    ...(duty.onMiss ? [`What to do about a miss: ${duty.onMiss}${duty.boardGoal ? ` Fixes go under the plan item ${duty.boardGoal}.` : ""}`] : []),
    ...(headline ? [`## Headline KPI\nThis run is judged on moving one number: ${headline.label} (${headline.key} ${headline.op} ${headline.target}${headline.unit ?? ""}). ` +
      "Spend the run on the work that moves it most; the other targets and the number of checks you run are detail."] : []),
    `Targets: ${counted.map(metric => `${metric.key} ${metric.op} ${metric.target}${metric.unit ?? ""} (${metric.label})`).join("; ")}.`,
    "## What the precheck found",
    `Measured against the targets: ${measure}. This is information, not a verdict: a met target does not mean nothing needs work, and code ` +
      "cannot see everything. Check the real state.",
    findings,
    ...(shown.length ? [`## Missed metrics: each one needs a fix step with a live job\n` +
      shown.map(streak => { const metric = counted.find(entry => entry.key === streak.key); return `- ${missLine(duty.id ?? "<dutyId>", streak, metric?.label ?? streak.key, metric?.unit)}`; }).join("\n") +
      "\n\nA miss is never accepted as it stands. A fix step is a plan step with `duty` set to `<dutyId>/<metricKey>` and `job` set to a job that " +
      "works on a code change, not a note or a later wait. When your turn ends, the server reads the board: a missed metric with no fix step whose " +
      "job is live sends you back with its name, so the run cannot end on an unowned miss. When a fix step closes, the server runs this duty again " +
      "at once to check the number moved."] : []),
    "## How to work",
    [
      `The chat's board is the JSON file ${chat.board}: the plan, the scratch notes with the owner's rulings, and the For you todos. Read it, then ` +
        "check the real state behind it: the jobs (`await agent_observe.list_agents()`, `await agent_observe.recent_messages(name)`), the commits, " +
        "the live pages, and other threads' last messages.",
      "Fix the issues you find and check what the duty specifies. You decide what to check and what to start from what you find: control flow " +
        "is decided by agents, not by loops in code.",
      ...focus,
      "Split work by the job rules: one goal per job, one subagent per unit of output, and work of 1 to 3 tool calls stays inline. Start " +
        "subagents with `await rlm.spawn(brief, name=...)`, all at once, each brief ending with `await agent_message.send(report, receiver_role=\"parent\")`; " +
        "end your turn, read each reply as it comes, and delete each subagent after its report. Work for another repository goes to " +
        "`await rlm.create_session(brief, name=..., cwd=...)`.",
      "Map the chat's work as a graph: one job or subagent per part, never steps piled on one old long-running session; when the findings list " +
        "a session that carries too much, move its steps to new jobs per part. Heartbeats the check-in covers go: name each for the chat to delete.",
      "You can message another thread yourself to chase it: `await agent_message.send(text, receiver_role=\"sibling\", receiver_name=<thread name>)`.",
      `Apply each board change to the chat's board yourself in this run, with \`import json, shlex\` and \`${apply}\`, where ops is a list of ` +
        "chat_board ops like `[{\"op\":\"plan_update\",\"id\":\"p4\",\"status\":\"done\",\"note\":\"live on production at 4f1c2a, checked on the live page\"}]`. " +
        "It refuses what chat_board refuses and prints each op's summary. Close a step only on evidence you name in its note. A step whose run, " +
        "probe, land or push has not finished green and landed stays open with its job, which is a live owner, and board-apply refuses that close.",
      "Every stuck step needs a live owner, a For you todo, or a close in this run. Give a step an owner that outlives this run with " +
        "`await rlm.create_session(brief, name=..., cwd=...)`, which registers the session as a job of the chat, and set the step's job to that " +
        "name in the same board change. A subagent you spawn is archived when the next run retires you, so spawn only for work that ends inside this run.",
      ...chatJobRules(),
      "When nothing needs work, end in one short turn and send nothing; the server keeps this run's record.",
      `Otherwise send the chat one report when your work is done, with only what it and the owner need: the board ops you applied, then at most 3 short ` +
        `plain lines the owner should hear, or "nothing for the owner". Send it with \`${send}\`.`,
    ].map(line => `- ${line}`).join("\n"),
  ].filter(part => part !== "").join("\n\n") + "\n";
}

/** A fix job's name: `fix <duty>` with the chat and start time, like `fix ci system VP of CI 20:41`. */
export const fixJobName = (duty: string, chat: string, at: number): string => dutyJobName(`fix ${duty}`, chat, at);

/** What the brief of a fix job the server opens holds: the duty, the chat, the job, and each missed metric with no live fix job. */
export interface FixJobInput {
  duty: Pick<DutyCard, "name" | "goal" | "metrics"> & { id: string };
  chat: Pick<DutyChat, "id" | "name" | "board">;
  job: string; at: number; misses: readonly MetricStreak[];
}

const bound = (op: string, value: number, unit = ""): string => `${op === "<=" ? "at most" : "at least"} ${value}${unit}`;

/**
 * The brief of the fix job the server opens for a duty that missed CHANGE_APPROACH_MISSES runs in a row while some missed metric had no fix step
 * with a live job (`Duties.ownFixes`): the job is the root-cause owner of those metrics, and the server links it on their plan steps.
 */
export function fixJobBrief({ duty, chat, job, at, misses }: FixJobInput): string {
  const metric = (key: string) => duty.metrics.find(entry => entry.key === key);
  const lines = misses.map(streak => {
    const found = metric(streak.key);
    const unit = found?.unit ?? "";
    return `- ${streak.key} (${found?.label ?? streak.key}) is ${streak.value}${unit}, target ${bound(streak.op, streak.target, unit)}, missed ${streak.misses} ` +
      `${streak.misses === 1 ? "run" : "runs"} in a row${streak.misses > 1 ? streak.moved ? ", moving toward the target" : ", not moving toward the target" : ""}` +
      `${streak.fix ? `. The last fix step ${streak.fix.step}${streak.fix.job ? ` (${streak.fix.job})` : ""} has no live job` : ""}. Its step: duty ${JSON.stringify(dutyLink(duty.id, streak.key))}.`;
  });
  return [
    `# ${job}: the root-cause fix for the ${duty.name} duty of the chat "${chat.name}"`,
    `You are the fix job "${job}" of the chat "${chat.name}" (session id ${chat.id}), started ${localTime(at)}. The chat server opened you because ` +
      `the ${duty.name} duty missed ${CHANGE_APPROACH_MISSES} or more runs in a row and these metrics had no fix step with a live job. The server ` +
      "set you as the job of each metric's plan step on the chat's board (the step whose `duty` field is named below), so you own them now.",
    `Duty goal: ${duty.goal}`,
    `## Missed metrics\n${lines.join("\n")}`,
    "## Your task",
    [
      "Find why each number misses: read the duty's precheck output and the code behind the number, and check the real state. A note, a later " +
        "wait or a lower target is not a fix, and an off-target metric is never fine as it stands (c75).",
      "Land the code change that moves the number, ship it the way the repo ships, and measure the number again. Close the step only on that " +
        "evidence, named in its note; the close starts a verify run of the duty.",
      "While you wait for a CI run or a time, set `board.wake(run=<id>)` or `board.wake(at=<time>)` before your turn ends, so the server reads you " +
        "as live. A turn that ends with no wake while a metric still misses brings a message back from the server.",
      `Apply each board change with \`import json, shlex\` and \`${boardApplyCall(chat)}\`, where ops is a list of chat_board ops.`,
      ...chatJobRules(),
      `Send the chat one report when the number moved or you are blocked, with the commit, the release and the number before and after. Send it with \`${reportCall(chat)}\`.`,
    ].map(line => `- ${line}`).join("\n"),
  ].join("\n\n") + "\n";
}

/** What the server sends a fix job whose turn ended with no wake while its metrics still miss and no other job works on them (`Duties.ownFixes`). */
export function fixMessage(duty: string, steps: readonly string[], misses: readonly MetricStreak[]): string {
  return `[duty] ${duty} still misses ${misses.map(streak => `${streak.key} (${streak.value}, target ${bound(streak.op, streak.target)})`).join(", ")}, ` +
    `and your step${steps.length === 1 ? "" : "s"} ${steps.join(", ")} ${steps.length === 1 ? "has" : "have"} no live job. Go on with the root cause and the code ` +
    "fix. While you wait for a CI run or a time, set board.wake before your turn ends. If your turn ends again with no board change, the server " +
    "opens a new fix job for these steps.";
}

/** The parts of the thread hub a duty job host uses. */
export interface DutyJobThreads {
  create(input: { cwd: string; name: string }): Promise<{ id: string }>;
  prompt(id: string, input: { message: string; images: []; mode: "steer" }): Promise<void>;
}

/** The archive the duty archive queue runs for a duty job: a session the catalog lists as live is archived; one archived or gone is done. */
export const archiveDutyJob = (threads: { archive(id: string): Promise<void> }, rows: () => Promise<readonly SessionRow[]>) => async (id: string): Promise<void> => {
  const found = (await rows()).find(candidate => candidate.id === id);
  if (found && !found.archived) await threads.archive(id);
};

/** The waits before each look for a session whose create failed (a timeout, a lost client): about 2 min in all. */
export const DUTY_LOOKUP_WAITS_MS: readonly number[] = [0, 10_000, 20_000, 30_000, 60_000];
/**
 * The daemon's refusal of a root name that any session ever had, archived ones included. A duty job's name holds only the clock time, so a
 * job started at the same minute on a later day collides with an archived one (frontend bro 10-12 03:41Z: "check-in frontend bro 12:39" was
 * taken by the archived job of 10-10, and both creates failed, so the check-in skipped).
 */
const NAME_TAKEN = /name .* is unavailable: an agent of that name already exists/i;
/** A taken duty job name with the local date before its time: `check-in frontend bro 10-12 12:39`. */
export const datedName = (name: string, at: number): string => {
  const date = localTime(at).slice(5, 10);
  return /\d\d:\d\d$/.test(name) ? name.replace(/(\d\d:\d\d)$/, `${date} $1`) : `${name} ${date}`;
};
/** Creates per start: the first and one retry when the session never appeared. */
const CREATE_TRIES = 2;

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The backend's duty job host: the chat's name and folder from the catalog rows, a job's state from its row (gone counts as done), a start, and
 * a retire that unregisters and queues the archive. Starts from every chat run one at a time (10-09: 9 chats' check-ins fired within 3 min and 6 creates
 * timed out). A start creates the root; a create that fails may still have made the session, so the start looks for an unregistered session
 * with the job's exact name in the chat's folder for about 2 min and adopts it, else creates once more. It then registers the session id under
 * the chat's name before the first message (the extension reads the registry at that message) and sends the brief. A session it cannot
 * register or brief has its archive queued, so no duty job session is left outside the registry. Every archive goes through `archives`.
 */
export function dutyJobHost(input: { threads: DutyJobThreads; archives: { add(job: DutyJobRef): Promise<void> }; rows: () => Promise<readonly SessionRow[]>;
  registry: JobRegistry; board: (chatId: string) => string;
  /** Runs after the job is registered and before its brief, so its first request already carries its pool class (low). */
  started?: (id: string) => Promise<void>;
  refresh?: () => Promise<void>; lookupWaitsMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; now?: () => number }): DutyJobHost {
  const row = async (id: string) => (await input.rows()).find(candidate => candidate.id === id);
  const waits = input.lookupWaitsMs ?? DUTY_LOOKUP_WAITS_MS;
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  /**
   * An unregistered live session with the job's name in the chat's folder, made since `since`. An older one is a past job with the same clock
   * time: 10-12 13:24Z the 22:24 Local dev servers start adopted the 10-10 22:24 job, its brief failed, and that session stayed loaded.
   */
  const find = async (chat: DutyChat, name: string, since: number): Promise<string | undefined> => {
    for (const wait of waits) {
      if (wait > 0) await sleep(wait);
      await input.refresh?.().catch(() => {});
      for (const candidate of await input.rows().catch(() => [])) {
        if (candidate.name !== name || candidate.cwd !== chat.cwd || candidate.archived || Date.parse(candidate.created ?? "") < since) continue;
        if (await input.registry.chatOf(candidate.id) === undefined) return candidate.id;
      }
    }
    return undefined;
  };
  const createOrAdopt = async (chat: DutyChat, first: string): Promise<{ id: string; name: string }> => {
    let cause = "";
    let name = first;
    const since = (input.now ?? Date.now)();
    for (let tries = 1; tries <= CREATE_TRIES; tries++) {
      try { return { id: (await input.threads.create({ cwd: chat.cwd, name })).id, name }; }
      catch (error) { cause = reason(error); }
      const found = await find(chat, name, since);
      if (found) { input.log?.(`duty job ${name}: the create failed (${cause}) but the session exists; adopting it`); return { id: found, name }; }
      input.log?.(`duty job ${name}: create ${tries} of ${CREATE_TRIES} failed and no session appeared: ${cause}`);
      if (NAME_TAKEN.test(cause)) name = datedName(first, (input.now ?? Date.now)());
    }
    throw new Error(`no session after ${CREATE_TRIES} creates: ${cause}`);
  };
  return {
    async chat(chatId) {
      let found = await row(chatId);
      if (!found && input.refresh) {
        await input.refresh().catch(error => { throw new Error(`the catalog cannot list the chat: ${reason(error)}`); });
        found = await row(chatId);
      }
      return found ? { id: chatId, name: found.name.trim() || chatId, cwd: found.cwd, board: input.board(chatId) } : null;
    },
    async working(job) { return (await row(job.id))?.working === true; },
    start: (chat, planned, brief) => serial(async () => {
      const { id, name } = await createOrAdopt(chat, planned);
      try {
        await input.registry.add([id], chat.name);
        await input.started?.(id);
        await input.threads.prompt(id, { message: name === planned ? brief : brief.split(planned).join(name), images: [], mode: "steer" });
      } catch (error) {
        await input.registry.remove([id]).catch(() => {});
        const archived = await input.archives.add({ id, name }).then(() => "queued its archive", archiveError => `its archive could not be queued: ${reason(archiveError)}`);
        throw new Error(`session ${id} could not be registered and briefed (${reason(error)}); ${archived}`);
      }
      return { id, name };
    }),
    async retire(job) {
      await input.registry.remove([job.id]);
      await input.archives.add(job);
    },
    async ended(last, older = []) {
      if (!last.length && !older.length) return [];
      const byId = new Map((await input.rows()).map(candidate => [candidate.id, candidate]));
      const idle = (job: DutyJobRef) => { const found = byId.get(job.id); return found !== undefined && !found.archived && !found.working ? found : undefined; };
      return [...last.filter(job => { const found = idle(job); return found !== undefined && found.messageCount >= 2 && found.failure === undefined; }),
        ...older.filter(job => idle(job) !== undefined)];
    },
    stop: job => input.archives.add(job),
    steer: (job, text) => input.threads.prompt(job.id, { message: text, images: [], mode: "steer" }),
  };
}
