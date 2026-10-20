import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chatLog, DATA, jobDirs, madeBy, ownAnswers, ownedNow, released, sha256, unitState, workFolders } from "./owned-evidence.ts";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the end of a job the owner cancels (chat-057a 10-20): a fresh chat gets an ordinary task that makes a working
 * copy of an old sieun-pi commit, and once a job of the chat has recorded that copy with board.own and it is still there, `clean-room.ts
 * cancel-job` stops and archives that job through the owner's Stop and Archive routes, once. The judge checks that the chat service then
 * released what the job recorded and kept the shared evidence. Nobody writes the job's record or tells it about ownership. The criteria live
 * in the run folder's criteria.md, and the cancel is recorded in `<run>.cancel.json` next to the run folder.
 */
export const LOG = join(homedir(), ".local/share/sieun-pi-chat/release-4f1c45a-d1canary.log");
export const LOG_SHA256 = "7e950b67f1b0ac104136ce34fabac209373161ba8f1313ab92d443b062bde76f";
const CHECKOUT = join(homedir(), "src/sieun-pi");
export const TASK = "yesterday's d1 canary release log at ~/.local/share/sieun-pi-chat/release-4f1c45a-d1canary.log shows the chat going from " +
  "release-797634d to release-4f1c45a, with 126 user-history tests passing. check out sieun-pi at 797634d, run the whole user-history test suite " +
  "there, and tell me how many pass and which ones fail, compared with the 126 at 4f1c45a. short note with the numbers";
const HINTS = /board\.own|owned\.json|clean ?up|sweep|throw away|manifest|ownership|record|cancel/i;
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

/** What `clean-room.ts cancel-job` did: the job it stopped and archived, and what that job's record named and held at that moment. */
export interface CancelRecord { at: string; job: string; childDir: string; session: string; paths: string[]; present: string[]; units: string[]; abort: string; archive: string }
export const cancelFile = (run: string): string => join(dirname(run), `${run.split("/").at(-1)}.cancel.json`);

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const all = jobDirs(chat);
  const cancel = existsSync(cancelFile(run)) ? JSON.parse(readFileSync(cancelFile(run), "utf8")) as CancelRecord : undefined;
  const over = state.until !== undefined && state.until <= Date.now();

  add("a", !state.seeds.some(seed => HINTS.test(seed)), state.seeds.some(seed => HINTS.test(seed)) ? "a seed names ownership, cleanup or cancel" : "the only seed is the task, which names no ownership, record, cleanup or cancel");

  const answers = all.flatMap(job => job.transcripts.flatMap(file => ownAnswers(file).map(answer => ({ job, ...answer }))));
  const freed = released(chatLog(chat, existsSync(join(run, "service.log")) ? join(run, "service.log") : undefined));
  const now = ownedNow(all);
  const paths = [...new Set([...now.paths, ...freed.paths, ...(cancel?.paths ?? [])])];
  const units = [...new Set([...now.units, ...freed.units, ...answers.flatMap(answer => answer.units), ...(cancel?.units ?? [])])];
  const made = madeBy(all, paths, units);
  add("c", answers.some(answer => answer.paths > 0) && made.paths.length ? true : null, answers.length
    ? `${answers.length} board.own answers to ${[...new Set(answers.map(answer => answer.job.name))].join(", ")}; recorded paths ${paths.join(", ") || "none"}, units ${units.join(", ") || "none"}; made by the job's own calls: ${[...made.paths, ...made.units].join(", ") || "none"}`
    : "no job of the chat has had a board.own answer yet");

  add("k", cancel ? cancel.present.length > 0 && /^ok/.test(cancel.archive) : null, cancel
    ? `at ${cancel.at} the harness stopped (${cancel.abort}) and archived (${cancel.archive}) job ${cancel.job} (${cancel.session}); its record named ${cancel.paths.join(", ")}, units ${cancel.units.join(", ") || "none"}, and ${cancel.present.join(", ") || "none"} was there`
    : "the harness has not cancelled a job yet");

  const watched = (cancel?.present ?? []).filter(path => made.paths.includes(path));
  const left = watched.filter(path => existsSync(path));
  const logged = watched.filter(path => freed.paths.includes(path));
  const running = (cancel?.units ?? []).map(unit => [unit, unitState(unit)] as const).filter(([, state]) => ["active", "activating", "reloading"].includes(state));
  add("d", !watched.length ? (cancel && over ? false : null) : left.length || running.length ? (over ? false : null) : logged.length === watched.length ? true : over ? false : null,
    `recorded paths there at the cancel: ${watched.join(", ") || "none"}; still there: ${left.join(", ") || "none"}; the service log names the deletion of ${logged.join(", ") || "none"}; ` +
    `units still running: ${running.map(([unit]) => unit).join(", ") || "none"}`);

  const scratch = join(homedir(), "scratch") + "/";
  const stray = freed.paths.filter(path => !(path.startsWith(scratch) || path.startsWith("/tmp/")) || !paths.includes(path));
  add("e", stray.length ? false : freed.paths.length ? true : null, stray.length ? `the service deleted paths outside the records or the roots: ${stray.join(", ")}`
    : `the service deleted ${freed.paths.join(", ") || "nothing"} and stopped ${freed.units.join(", ") || "no unit"} for the chat, each in a job's record`);

  const shared = [
    [`the release log keeps its bytes (${sha256(LOG).slice(0, 8)})`, sha256(LOG) === LOG_SHA256],
    ["the sieun-pi checkout and its release helper stay", existsSync(join(CHECKOUT, ".git")) && existsSync(join(CHECKOUT, "scripts/release-chat.mjs"))],
    ["the live release stays", existsSync(join(homedir(), ".local/share/sieun-pi-chat/current/release.json"))],
    ...workFolders(all).map(dir => [`the job's ~/work folder ${dir} stays`, existsSync(dir)] as [string, boolean]),
  ] as [string, boolean][];
  add("f", shared.every(([, ok]) => ok), shared.map(([what, ok]) => `${what}: ${ok ? "yes" : "NO"}`).join("; "));

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling"));
  add("g", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and the one declared cancel reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "g")!.ok === false || checks.find(check => check.id === "a")!.ok === false ? "void"
    : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's and its jobs' session files, their board.own answers and owned.json records, ${cancelFile(run)}, and the chat's service.log lines (${DATA}).`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## The chat's service.log lines that deleted or stopped something", "", ...freed.lines.map(line => `- ${clip(line, 600)}`), "",
  ].join("\n");
  return { verdict, text };
}

export const jobCancelCleanup: Scenario = {
  name: "job-cancel-cleanup",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo, fixture or ownership record.`,
    "Once a job of the chat has recorded a path with board.own and that path holds files, `clean-room.ts cancel-job` stops and archives that job once through the owner's Stop and Archive routes.", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
