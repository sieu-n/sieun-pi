// Guards the 10-27 lost triage brief. The alert bridge started "alert triage CI and RepoOps 23:43" (01a17dd0) at 14:43:38Z; Prime took its
// brief, and its first run waited in pi-pool's turn queue (73 queued) until every worker was gone at the 16:48:54Z supervisor restart. Prime
// holds a new session's first prompt in memory until the first reply, so the file kept only these 7 lines, and no brief record existed for a
// job the chat service starts itself, so nothing sent the brief again. The bridge read the job as ended at 16:49:42Z and started another.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEFS_DIR, briefFile, briefTick, seeBrief, serviceBriefs } from "../src/brief-keeper.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { jobLive, RESENT_MS } from "../src/job-live.ts";
import type { SessionRow } from "../src/shared/types.ts";

const JOB = "01a17dd0-eaee-77f5-9251-96e159e4664e";
const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const NAME = "alert triage CI and RepoOps 23:43";
const STARTED = Date.parse("2026-10-27T14:43:38.462Z");
const RESTART = Date.parse("2026-10-27T16:48:54.000Z");
const BRIEF = "Owner's words (verbatim): \"when p6 is achieved, it is your duty to keep LGTM and Grafana dashbaords up to date to any changes, and carefully tune the alerts system.\" ci-cache-stale and ci-tip-sentinel-stalled fire for the chat CI and RepoOps.";
/** The 7 lines 01a17dd0's file held from 14:43 to 23:06Z on 10-27. */
const LINES = [{"type": "session", "version": 3, "id": "01a17dd0-eaee-77f5-9251-96e159e4664e", "timestamp": "2026-10-27T14:43:26.062Z", "cwd": "/Users/sieunpark/Documents/Github/auto-sns-agent", "rlmDepth": 0, "git": {"repoUrl": "https://github.com/sieu-n/auto-sns-agent", "commit": "e0a19af4f74803f791f3484366edab3460907546", "branch": "dev/sieun"}}, {"type": "model_change", "id": "aad0fd84", "parentId": null, "timestamp": "2026-10-27T14:43:26.837Z", "provider": "anthropic", "modelId": "claude-opus-5-5"}, {"type": "thinking_level_change", "id": "f8b383dd", "parentId": "aad0fd84", "timestamp": "2026-10-27T14:43:26.837Z", "thinkingLevel": "high"}, {"type": "service_tier_change", "id": "2308fcd7", "parentId": "f8b383dd", "timestamp": "2026-10-27T14:43:26.837Z", "serviceTier": "default"}, {"type": "session_state", "id": "d9d9b100", "parentId": "2308fcd7", "timestamp": "2026-10-27T14:43:26.891Z", "state": {"status": "active"}}, {"type": "session_info", "id": "590794eb", "parentId": "d9d9b100", "timestamp": "2026-10-27T14:43:35.132Z", "name": "alert triage CI and RepoOps 23:43"}, {"type": "custom_message", "customType": "prime-agent.worker_recovery", "content": "<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>", "display": false, "details": {"activeSessionId": "c6188c402bbf", "operations": ["session_action_update"]}, "id": "59f2ccb0-0f22-4f06-ac83-e7e5a335be3b", "parentId": "590794eb", "timestamp": "2026-10-27T16:48:55.385Z"}];
const FIRED_AGAIN = "[alert] A rule of this chat fired after your brief: ci-runner-lost (CI runner lost jobs).";

async function lostJob() {
  const root = await mkdtemp(join(tmpdir(), "service-brief-"));
  const sessions = join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, `${JOB}.jsonl`);
  await writeFile(file, LINES.map(line => JSON.stringify(line)).join("\n") + "\n");
  const dir = join(root, "data", BRIEFS_DIR);
  const prompts: string[] = [];
  const archived: string[] = [];
  const chat = { id: CHAT, name: "CI and RepoOps", cwd: "/repo/auto-sns-agent", board: join(root, "board.json") };
  const host = dutyJobHost({
    threads: { create: async () => ({ id: JOB }), prompt: async (_id, input) => { prompts.push(input.message); } },
    archives: { add: async job => { archived.push(job.id); } }, rows: async () => [{ id: CHAT, name: chat.name, cwd: chat.cwd } as SessionRow],
    registry: { add: async () => {}, chatOf: async () => undefined, chatIdOf: async () => undefined, rootsOf: async () => [], remove: async () => {} },
    board: () => chat.board, now: () => STARTED,
    briefs: serviceBriefs(dir, async id => { const own = join(sessions, `${id}.jsonl`); return readFile(own).then(() => own, () => null); }) });
  return { root, file, dir, host, chat, prompts, archived };
}

test("a job the chat service starts keeps its brief for the keeper, and a retire or stop forgets it", async () => {
  const job = await lostJob();
  try {
    await job.host.start(job.chat, NAME, BRIEF, STARTED, { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" });
    assert.deepEqual(job.prompts, [BRIEF]);
    const record = JSON.parse(await readFile(briefFile(job.dir, "root", JOB), "utf8"));
    assert.deepEqual(record, { kind: "root", id: JOB, name: NAME, prompt: BRIEF, at: STARTED, root: JOB, sessionFile: job.file, model: "anthropic/claude-opus-5-5", thinking: "high" });
    await job.host.retire({ id: JOB, name: NAME });
    assert.deepEqual(await readdir(job.dir), [], "a retired job is not briefed again");
    await job.host.start(job.chat, NAME, BRIEF, STARTED);
    assert.ok(job.host.stop);
    await job.host.stop({ id: JOB, name: NAME });
    assert.deepEqual(await readdir(job.dir), [], "nor is a stopped one");
  } finally { await rm(job.root, { recursive: true, force: true }); }
});

test("a session with no brief gets it again once its worker is gone, even when a later fire landed first", async () => {
  const job = await lostJob();
  try {
    await job.host.start(job.chat, NAME, BRIEF, STARTED);
    const record = JSON.parse(await readFile(briefFile(job.dir, "root", JOB), "utf8"));
    const sends: [string, string, string | undefined][] = [];
    const deps = { dir: job.dir, log: () => {}, deliver: async (session: string, text: string, tree?: string) => { sends.push([session, text, tree]); } };
    assert.equal(await briefTick({ ...deps, worker: async () => ({ id: "dd37ca6826a8", ran: true }), now: () => STARTED + 2 * 3_600_000 }), 0,
      "while the worker whose run waits in pi-pool's queue lives, the brief is in its hands");
    await appendFile(job.file, JSON.stringify({ type: "custom_message", customType: "agent_message", content: FIRED_AGAIN, display: true, timestamp: new Date(RESTART + 30_000).toISOString() }) + "\n");
    assert.equal((await seeBrief(record)).started, false, "a later fire is not the brief");
    assert.equal(await briefTick({ ...deps, worker: async () => undefined, now: () => RESTART + 60_000 }), 1, "the restart took the worker: the brief goes again");
    assert.deepEqual(sends.map(([session, , tree]) => [session, tree]), [[JOB, JOB]], "the outbox reopens the job's own tree");
    assert.ok(sends[0]![1].startsWith(BRIEF));
    await appendFile(job.file, JSON.stringify({ type: "custom_message", customType: "agent_message", content: sends[0]![1], display: true, timestamp: new Date(RESTART + 61_000).toISOString() }) + "\n");
    assert.equal(await briefTick({ ...deps, worker: async () => undefined, now: () => RESTART + 90_000 }), 0);
    assert.deepEqual(await readdir(job.dir), [], "the brief landed: the record goes");
  } finally { await rm(job.root, { recursive: true, force: true }); }
});

test("the alert bridge reads a job whose brief the keeper owes or just sent as about to run, and one past that as ended", async () => {
  const job = await lostJob();
  try {
    const paths = { wakes: join(job.root, "wakes"), turns: join(job.root, "turns.json"), watchdogLog: join(job.root, "log.jsonl"), briefs: job.dir };
    assert.equal(await jobLive(paths, JOB, RESTART + 48_000), null, "no record: nothing owes it");
    await job.host.start(job.chat, NAME, BRIEF, STARTED);
    assert.equal(await jobLive(paths, JOB, RESTART + 48_000), "the brief keeper still owes it its brief");
    await briefTick({ dir: job.dir, log: () => {}, deliver: async () => {}, worker: async () => undefined, now: () => RESTART + 60_000 });
    assert.equal(await jobLive(paths, JOB, RESTART + 90_000), "the brief keeper sent it its lost brief at 16:49:54Z");
    assert.equal(await jobLive(paths, JOB, RESTART + 60_000 + RESENT_MS), null, "a resend that started nothing in RESENT_MS lets the bridge replace the job");
  } finally { await rm(job.root, { recursive: true, force: true }); }
});
