// Guards the 10-19 reporting gap of chat-057a's jobs: legacy socket ownership (01a15525) and four more woke at 17:52Z to 18:40Z, met a 429 on
// claude18 at the model start, and ended their turns with stopReason error and an empty reply. The agents panel showed the daemon's summary
// cut 200 characters into the provider's prose, the [job] notice its first 120 characters, and the no-report notice "ended at ... with no
// report": none of them said the account, its limit or the retry time pi-pool gave. The job sweep then dropped its verdict on them with no log
// line. On 10-21 the sweep still skipped every cut job of chat-057a for the owner's 10-19 archive of the chat, though the chat had kept running
// as a hidden session since and the jobs were its later work.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { rosterChildren, subagentSessions } from "../src/chat-catalog.ts";
import { jobEnd, jobEndText, noReportNotice } from "../src/chat-checkin.ts";
import { CHAT_ARCHIVED, InterruptedRuns, resumeChatJobs } from "../src/chat-resume.ts";
import { clockTime } from "../src/checkin-settings.ts";
import { cutActivity, cutEnd, SessionCuts } from "../src/cut-end.ts";
import type { InterruptedReport } from "../src/shared/interrupted.ts";
import { turnErrorCause } from "../src/turn-error.ts";
import { row } from "./chats-helpers.ts";

const CHAT = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const JOB = "01a15525-4943-735c-bbd4-a7f524a205fd";
const ERROR = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. [request_id: req_011CgC2pPcMAK6SSx8jUK5Lb] pi-pool: claude18@slack.green is limited until 2026-10-19T21:10:00.000Z; this session waits for its slot at 2026-10-19T18:16:00.000Z. Try again in 16 minutes.";
/** The tail of 01a15525's transcript from its wake to the idle unload's stop, as written on us-metal02 (the wake text cut short). */
const LINES = [
  JSON.stringify({ type: "custom_message", customType: "agent_message", content: "[agent-message from b0940cf33db8]\n\n[wake] It is 2026-10-19T17:52:24.793Z", display: true, timestamp: "2026-10-19T18:00:13.496Z" }),
  JSON.stringify({ type: "message", id: "1694f700", parentId: "0aa470f3", timestamp: "2026-10-19T18:00:15.359Z", message: { role: "assistant", content: [], api: "anthropic-messages",
    provider: "anthropic", model: "claude-opus-5-5", stopReason: "error", timestamp: 1792432814797, errorMessage: ERROR } }),
  JSON.stringify({ type: "session_state", id: "c205426a", parentId: "1694f700", timestamp: "2026-10-19T18:10:40.189Z", state: { status: "archived" } }),
  JSON.stringify({ type: "session_state", id: "6e39aa66", parentId: "c205426a", timestamp: "2026-10-19T18:10:43.033Z", state: { status: "active" } }),
];
const at = (iso: string) => Date.parse(iso);
const CAUSE = `rate limit 429, claude18 limited until ${clockTime(at("2026-10-19T21:10:00Z"))}, retries at ${clockTime(at("2026-10-19T18:16:00Z"))}`;

test("a failed turn's cause names the kind, the pool account's limit and the retry time, with no request id", () => {
  assert.equal(turnErrorCause(ERROR), CAUSE);
  assert.ok(!turnErrorCause(ERROR).includes("req_"));
  assert.equal(turnErrorCause('Failed to resolve API key for provider "anthropic" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token'), "no account token from pi-pool");
  assert.equal(turnErrorCause("Connection error."), "connection error");
  assert.equal(turnErrorCause("503 upstream connect error"), "provider server error 503");
  assert.equal(turnErrorCause("Something odd happened with key sk-ant-abcdefghijklmnopqrstuvwxyz. More text here."), "Something odd happened with key <id>.");
  assert.equal(turnErrorCause(""), "the model returned an error with no message");
});

test("the agents panel line of a job cut on a 429 names the cause, also when the daemon already settled it as failed", () => {
  const cut = cutEnd(LINES)!;
  assert.equal(cut.error, CAUSE);
  assert.equal(cutActivity(cut), `stopped on a provider error at ${clockTime(at("2026-10-19T18:00:15.359Z"))} (${CAUSE}), no report since`);
  const cuts = new SessionCuts();
  cuts.of = (file: string | undefined) => file === "/tmp/job.jsonl" ? cut : null;
  const summary = "Model request failed: Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. [request_id: req_011CgC2pPcMA…";
  const daemonRow = { sessionId: JOB, parentSessionId: CHAT, rlmChildId: "sub-646f888a", runtimeKind: "subagent", sessionName: "legacy socket ownership", cwd: "/home/sieun",
    messageCount: 126, lastActivityAt: "2026-10-19T18:10:43.033Z", sessionFile: "/tmp/job.jsonl", summary, taskState: "error" } as unknown as SessionSummary;
  const [session] = subagentSessions([daemonRow], new Map(), cuts);
  assert.equal(session!.failed, true);
  assert.equal(session!.activity, cutActivity(cut));
  const [child] = rosterChildren([daemonRow], cuts).get(CHAT)!;
  assert.deepEqual([child!.status, child!.error], ["error", cutActivity(cut)]);
});

test("the [job] notices of a failed turn say how it failed instead of reading like a quiet end", () => {
  const end = jobEnd([{ role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason: "error", timestamp: at("2026-10-19T18:00:15.359Z"), errorMessage: ERROR }])!;
  assert.equal(jobEndText("legacy socket ownership", end),
    `legacy socket ownership stopped on a provider error (${CAUSE}) at ${clockTime(end.at)} and sent no report`);
  const failure = cutActivity(cutEnd(LINES)!);
  assert.equal(noReportNotice("legacy socket ownership", undefined, 0, at("2026-10-19T18:10:43.033Z"), failure), `legacy socket ownership ${failure}`);
  assert.equal(noReportNotice("legacy socket ownership", undefined, 0, at("2026-10-19T18:10:43.033Z")),
    `legacy socket ownership ended at ${clockTime(at("2026-10-19T18:10:43.033Z"))} with no report`, "a quiet end keeps its words");
});

test("the job sweep logs once each cut job an owner's chat archive after its last message holds, the turn's cause apart from the archive, and resumes nothing of it", async () => {
  const archived = { id: JOB.slice(-12), name: "legacy socket ownership", session_id: JOB, head: "d9abd5ee761c", head_session_id: CHAT,
    stopped_at: "2026-10-19T18:10:40.189Z", stopped_by: CHAT_ARCHIVED, cut: "error", cut_error: ERROR, cut_at: "2026-10-19T18:00:15.359Z" };
  const deleted = { ...archived, id: "other", name: "far job", session_id: "01a15000-0000-7000-8000-000000000000", stopped_by: "deleted on purpose" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return { paused: [], heads: [], checked_at: "now", stopped: [archived, deleted] } satisfies InterruptedReport; });
  const lines: string[] = [];
  const pass = () => resumeChatJobs([row("01a1164b-4a2d-742d-b27a-82f086ed0200", "2026-10-19T18:47:00Z")], new Set(["01a1164b-4a2d-742d-b27a-82f086ed0200"]),
    (isJob, owners) => runs.resumeJobs(isJob, async () => {}, owners), line => lines.push(line));
  await pass();
  await pass();
  assert.deepEqual(calls, [["--dry-run", "--direct"], ["--dry-run", "--direct"]], "no send pass");
  assert.deepEqual(lines, [`job legacy socket ownership: turn stopped: ${CAUSE} at 2026-10-19T18:00:15.359Z. Not resumed: the owner archived its chat after its last message `
    + `(archived-chats.json), so the sweep does not restart it (${JOB})`]);
  assert.ok(!lines[0]!.includes("archived by the owner"), "the job is never said to be stopped by the owner");
});

test("the job sweep continues a cut job of a hidden chat and leaves the one the owner stopped", async () => {
  // On 10-21 p8-supersede, lrv-s2-hb and metal agent runtime of chat-057a, which the owner archived at 05:31:26Z on 10-19, slept after 429s on
  // claude5 while every sweep skipped them. The script now lists such a job as paused once pi-pool admits its tree, and the sweep must send it.
  const cut = { id: JOB.slice(-12), name: "p8-supersede", reason: "error" as const, session_id: JOB, head: "d9abd5ee761c", head_session_id: CHAT,
    error: ERROR, errored_at: "2026-10-21T05:31:26.482Z" };
  const stopped = { id: "a1b2c3d4e5f6", name: "owner stopped job", session_id: "01a15c47-0000-7000-8000-000000000001", head: "d9abd5ee761c", head_session_id: CHAT,
    stopped_at: "2026-10-21T05:40:00.000Z", stopped_by: "the owner stopped it (job-cancels.json, at 2026-10-21T05:40:00Z)" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => {
    calls.push([...args]);
    if (args.includes("--dry-run")) return { paused: [cut], heads: [], checked_at: "now", stopped: [stopped] } satisfies InterruptedReport;
    return { paused: [cut], heads: [], children: [{ id: cut.id, name: cut.name, head: cut.head, result: { deliveryStatus: "delivered" } }], checked_at: "now" } satisfies InterruptedReport;
  });
  const lines: string[] = [];
  const chat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
  await resumeChatJobs([row(chat, "2026-10-21T05:47:00Z")], new Set([chat]), (isJob, owners) => runs.resumeJobs(isJob, async () => {}, owners),
    line => lines.push(line), new Set(), undefined, new Set([CHAT]));
  assert.deepEqual(calls, [["--dry-run", "--direct"], ["--direct", "--only", JOB, "--this-box"]]);
  assert.deepEqual(lines, [`job p8-supersede: interrupted (error at 2026-10-21T05:31:26.482Z); continue: {"deliveryStatus":"delivered"}`,
    `job owner stopped job: not resumed, stopped on purpose: ${stopped.stopped_by} (${stopped.session_id})`]);
});
