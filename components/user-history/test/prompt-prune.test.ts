import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { DutyStore } from "../src/chat-duty-store.ts";
import { deletedJobRecord } from "../src/chat-sources.ts";
import { IdIndex } from "../src/id-index.ts";
import { recordPrompt } from "../src/prompt-capture.ts";
import { prunePrompts, pruneSummary } from "../src/prompt-prune.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const LIVE = "01a14000-0000-7000-8000-00000000000a";
const ARCHIVED_CHAT = "01a14000-0000-7000-8000-00000000000b";
const ARCHIVED_THREAD = "01a14000-0000-7000-8000-00000000000c";
const GONE = "01a14000-0000-7000-8000-00000000000d";
const NO_FILE = "01a14000-0000-7000-8000-00000000000e";
const NEW = "01a14000-0000-7000-8000-00000000000f";
const DUTY_JOB_1 = "01a14000-0000-7000-8000-000000000011";
const DUTY_JOB_2 = "01a14000-0000-7000-8000-000000000012";
const CHECK_IN_JOB = "01a14000-0000-7000-8000-000000000013";
const LIVE_SUB = "01a14000-0000-7000-8000-000000000021";
const DELETED_SUB = "01a14000-0000-7000-8000-000000000022";
const DELETED_SUB_CHILD = "01a14000-0000-7000-8000-000000000023";
const ARCHIVED_CHAT_SUB = "01a14000-0000-7000-8000-000000000024";
const UNLISTED_SUB = "01a14000-0000-7000-8000-000000000025";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prompt-prune-"));
  const agentDir = join(root, "agent");
  const dataDir = join(agentDir, "browser-chat");
  const sessions = join(agentDir, "sessions");
  const artifacts = join(agentDir, "session-artifacts");
  await mkdir(sessions, { recursive: true });
  const topFile = (id: string) => join(sessions, `${id}.jsonl`);
  const subFile = (parts: string[], id: string) => join(artifacts, ...parts, `${id}.jsonl`);
  const files: Record<string, string | null> = {
    [LIVE]: topFile(LIVE), [ARCHIVED_CHAT]: topFile(ARCHIVED_CHAT), [ARCHIVED_THREAD]: topFile(ARCHIVED_THREAD), [GONE]: topFile(GONE), [NO_FILE]: null,
    [NEW]: topFile(NEW), [DUTY_JOB_1]: topFile(DUTY_JOB_1), [DUTY_JOB_2]: topFile(DUTY_JOB_2), [CHECK_IN_JOB]: topFile(CHECK_IN_JOB),
    [LIVE_SUB]: subFile([LIVE, "sub-live0001"], LIVE_SUB), [DELETED_SUB]: subFile([LIVE, "sub-dead0001"], DELETED_SUB),
    [DELETED_SUB_CHILD]: subFile([LIVE, "sub-dead0001", "sub-kid00001"], DELETED_SUB_CHILD), [ARCHIVED_CHAT_SUB]: subFile([ARCHIVED_CHAT, "sub-arch0001"], ARCHIVED_CHAT_SUB),
    [UNLISTED_SUB]: subFile([LIVE, "sub-gone0001"], UNLISTED_SUB),
  };
  for (const [id, file] of Object.entries(files)) {
    if (file && id !== GONE) { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, "{}\n"); }
    await recordPrompt(dataDir, { capturedAt: "2026-10-16T00:00:00.000Z", sessionId: id, sessionFile: file, provider: "anthropic", model: "claude-opus-5-5",
      payload: { messages: [{ role: "user", content: "x".repeat(1000) }] } });
  }
  await new IdIndex(join(dataDir, "archived-chats.json"), "Archived chat index").add(ARCHIVED_CHAT);
  await deletedJobRecord(join(dataDir, "deleted-jobs.json")).add(LIVE, "sub-dead0001", Date.now(), ["sub-dead0001", "sub-live0001"]);
  const store = new DutyStore(dataDir);
  const run = (duty: string, at: number, job?: string): DutyRunRecord => ({ duty, at, trigger: "schedule", ms: 0, verdict: job ? "met" : "skipped", metrics: {}, summary: "",
    ...(job ? { job: { id: job, name: `${duty} job ${at}` } } : {}) });
  await store.updateFile(LIVE, () => {});
  await store.appendRun(LIVE, run("checkin", 1, CHECK_IN_JOB));
  await store.appendRun(LIVE, run("d1", 2, DUTY_JOB_1));
  await store.appendRun(LIVE, run("d1", 3));
  const row = (sessionId: string, extra: Partial<SessionSummary> = {}) => ({ sessionId, cwd: root, sessionFile: files[sessionId] ?? undefined, ...extra }) as SessionSummary;
  const rows: SessionSummary[] = [
    row(LIVE), row(ARCHIVED_CHAT), row(ARCHIVED_THREAD, { lifecycle: "archived" }), row(GONE),
    row(DUTY_JOB_1, { lifecycle: "archived" }), row(CHECK_IN_JOB, { lifecycle: "archived" }),
    row(LIVE_SUB, { parentSessionId: LIVE }), row(DELETED_SUB, { parentSessionId: LIVE }), row(DELETED_SUB_CHILD, { parentSessionId: DELETED_SUB }),
    row(ARCHIVED_CHAT_SUB, { parentSessionId: ARCHIVED_CHAT }),
  ];
  const lines: string[] = [];
  const source = { dataDir, agentDir, rows: async () => rows, log: (line: string) => { lines.push(line); } };
  return { dataDir, store, run, rows, row, source, lines };
}

const left = async (dataDir: string) => new Set((await readdir(join(dataDir, "prompts"))).map(name => name.replace(/\.json$/, "")));

test("the prune deletes the captures of ended sessions and their subagents, keeps live ones and each duty's newest run", async () => {
  const { dataDir, source } = await fixture();
  const result = await prunePrompts(source);
  const reasons = Object.fromEntries(result.deleted.map(entry => [entry.name.replace(/\.json$/, ""), entry.reason]));
  assert.deepEqual(reasons, {
    [ARCHIVED_CHAT]: "archived chat", [ARCHIVED_CHAT_SUB]: "archived chat", [ARCHIVED_THREAD]: "archived thread",
    [DELETED_SUB]: "deleted job", [DELETED_SUB_CHILD]: "deleted job", [UNLISTED_SUB]: "deleted job", [GONE]: "no session file", [NO_FILE]: "no session file",
  });
  assert.deepEqual(await left(dataDir), new Set([LIVE, LIVE_SUB, NEW, DUTY_JOB_1, DUTY_JOB_2, CHECK_IN_JOB]));
  assert.equal(result.kept.files, 6);
  assert.equal(result.kept.dutyRuns, 2);
  assert.ok(result.deleted.every(entry => entry.bytes > 1000));
  assert.match(pruneSummary(result), /^prompt prune: deleted 8 files, 0\.0 MB \(.*archived chat 2 .*\); kept 6 files, 0\.0 MB, 2 of them a duty's newest run$/);
});

test("an archived duty job's capture stays until its duty's next run starts a job, then goes", async () => {
  const { dataDir, source, store, run, rows, row } = await fixture();
  await prunePrompts(source);
  assert.ok((await left(dataDir)).has(DUTY_JOB_1));
  await store.updateFile("01a14000-0000-7000-8000-0000000000ff", () => {});
  await store.appendRun("01a14000-0000-7000-8000-0000000000ff", run("d1", 4, DUTY_JOB_2));
  await prunePrompts(source);
  assert.ok((await left(dataDir)).has(DUTY_JOB_1), "another chat's d1 run does not replace this chat's");
  await store.appendRun(LIVE, run("d1", 5, DUTY_JOB_2));
  rows.push(row(DUTY_JOB_2));
  const result = await prunePrompts(source);
  assert.deepEqual(result.deleted.map(entry => [entry.name, entry.reason]), [[`${DUTY_JOB_1}.json`, "archived thread"]]);
  assert.ok((await left(dataDir)).has(DUTY_JOB_2));
  assert.ok((await left(dataDir)).has(CHECK_IN_JOB));
});

test("a second run deletes nothing, temp files of a gone writer go, and no daemon list still prunes the rest", async () => {
  const { dataDir, source, lines } = await fixture();
  const prompts = join(dataDir, "prompts");
  await writeFile(join(prompts, `${LIVE}.json.${process.pid}.7.tmp`), "{");
  await writeFile(join(prompts, `${GONE}.json.999999999.3.tmp`), "{");
  const first = await prunePrompts({ ...source, rows: async () => { throw new Error("daemon down"); } });
  assert.ok(lines.some(line => line.includes("no daemon list")));
  assert.ok(first.deleted.some(entry => entry.reason === "stale temp file"));
  assert.ok(!first.deleted.some(entry => entry.reason === "archived thread" || entry.name === `${UNLISTED_SUB}.json`));
  assert.ok((await left(dataDir)).has(`${LIVE}.json.${process.pid}.7.tmp`));
  const second = await prunePrompts(source);
  assert.deepEqual(second.deleted.map(entry => entry.reason).sort(), ["archived thread", "deleted job"]);
  const third = await prunePrompts(source);
  assert.deepEqual(third.deleted, []);
});
