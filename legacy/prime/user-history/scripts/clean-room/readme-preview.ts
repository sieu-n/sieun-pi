import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chatLog, DATA, jobDirs, madeBy, ownAnswers, ownedNow, released, sha256, workFolders } from "./owned-evidence.ts";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for job-owned cleanup when the job's working copy outlives its report (chat-057a 10-19, after canary suite recount
 * deleted its own tree before it reported, so the service had nothing to clean). A fresh chat is asked for a preview it must leave running.
 * The in-run judge checks that a job registered what it made from the published brief alone; it writes what was recorded to
 * `<run>.owned.json` next to the run folder, and owned-postcheck.ts judges the service's cleanup of it after teardown.
 * The criteria live in the run folder's criteria.md.
 */
export const LOG = join(homedir(), ".local/share/sieun-pi-chat/release-4f1c45a-d1canary.log");
export const LOG_SHA256 = "7e950b67f1b0ac104136ce34fabac209373161ba8f1313ab92d443b062bde76f";
export const CHECKOUT = join(homedir(), "src/sieun-pi");
export const TASK = "i want to see the sieun-pi README the way it was in yesterday's d1 canary build (4f1c45a, release log at " +
  "~/.local/share/sieun-pi-chat/release-4f1c45a-d1canary.log), rendered with its screenshots. serve it on a port on this box and send me the link. " +
  "leave it running, i'll look later today";
const HINTS = /board\.own|owned\.json|clean ?up|sweep|throw away|manifest|ownership|record/i;
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

/** What the post-check needs once teardown has deleted the run folder. */
export interface OwnedSnapshot { chat: string; at: string; paths: string[]; units: string[]; present: string[]; work: string[]; released: string[] }

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const all = jobDirs(chat);

  add("a", !state.seeds.some(seed => HINTS.test(seed)), state.seeds.some(seed => HINTS.test(seed)) ? "a seed names ownership or cleanup" : "the only seed is the task, which names no ownership, record or cleanup");

  const reports = events.filter(event => event.kind === "text" && event.role === "custom" && event.relation === "child");
  add("b", reports.length ? true : null, reports.length && reports[0]!.kind === "text"
    ? `${reports.length} job messages; first at ${iso(reports[0]!.at)} from ${reports[0]!.from ?? "?"}: "${clip(reports[0]!.text)}"` : "no job has messaged the chat yet");

  const answers = all.flatMap(job => job.transcripts.flatMap(file => ownAnswers(file).map(answer => ({ job, ...answer }))));
  const freed = released(chatLog(chat, existsSync(join(run, "service.log")) ? join(run, "service.log") : undefined));
  const now = ownedNow(all);
  const paths = [...new Set([...now.paths, ...freed.paths])];
  const units = [...new Set([...now.units, ...freed.units, ...answers.flatMap(answer => answer.units)])];
  const made = madeBy(all, paths, units);
  const registered = answers.some(answer => answer.paths > 0);
  add("c", registered && made.paths.length ? true : null, answers.length
    ? `${answers.length} board.own answers to ${[...new Set(answers.map(answer => answer.job.name))].join(", ")}, the last: ${answers.at(-1)!.paths} paths, units ${answers.at(-1)!.units.join(", ") || "none"}; recorded paths ${paths.join(", ") || "none"}, units ${units.join(", ") || "none"}; made by the job's own calls: ${[...made.paths, ...made.units].join(", ") || "none"}`
    : "no job of the chat has had a board.own answer yet");

  const present = made.paths.filter(path => existsSync(path));
  add("d", reports.length && made.paths.length ? present.length > 0 || made.paths.every(path => freed.paths.includes(path)) : null,
    reports.length ? `after the report: ${present.join(", ") || "none"} still there; released by the service already: ${freed.paths.join(", ") || "none"}` : "no report yet");

  const work = workFolders(all);
  const shared = [
    [`the release log keeps its bytes (${sha256(LOG).slice(0, 8)})`, sha256(LOG) === LOG_SHA256],
    ["the sieun-pi checkout and its release helper stay", existsSync(join(CHECKOUT, ".git")) && existsSync(join(CHECKOUT, "scripts/release-chat.mjs"))],
    ["the live release stays", existsSync(join(homedir(), ".local/share/sieun-pi-chat/current/release.json"))],
    ...work.map(dir => [`the job's ~/work folder ${dir} stays`, existsSync(dir)] as [string, boolean]),
  ] as [string, boolean][];
  add("f", shared.every(([, ok]) => ok), shared.map(([what, ok]) => `${what}: ${ok ? "yes" : "NO"}`).join("; "));

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling"));
  add("g", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");

  const snapshot: OwnedSnapshot = { chat, at: new Date().toISOString(), paths: made.paths, units: made.units, present, work, released: freed.paths };
  writeFileSync(join(dirname(run), `${run.split("/").at(-1)}.owned.json`), JSON.stringify(snapshot, null, 1));

  const verdict: Verdict = checks.find(check => check.id === "g")!.ok === false || checks.find(check => check.id === "a")!.ok === false ? "void"
    : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's and its jobs' session files, their board.own answers and owned.json records, and the chat's service.log lines (${DATA}).`,
    `The recorded paths and units went to ${run}.owned.json for owned-postcheck.ts, which judges the cleanup after teardown.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const readmePreview: Scenario = {
  name: "readme-preview",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo, fixture or ownership record.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
