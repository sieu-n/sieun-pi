import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { checkInSettings, clockTime } from "../src/checkin-settings.ts";
import { Chats, NO_REPORT_BUSY_TRIES } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { noticeStands } from "../src/no-report.ts";
import { JOB_NOTICE_PREFIX } from "../src/shared/chat-feed.ts";
import type { ChildAgent, ThreadMessage } from "../src/shared/types.ts";

/**
 * VP of CI 10-13: the server told the chat "[job] repo rules check fix ended at 18:20 with no report" at 09:22Z, restarted at 09:25Z
 * (release b34de98), and sent the same line again at 09:52:12Z. The job had pushed again at 09:45Z and reported at 09:47:30Z, but the chat was
 * mid-turn, so the daemon held that report until 09:52:15Z. Chat health counted the second line in off_brief.
 */
const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const JOB = "repo rules check fix";
const ENDED = Date.parse("2026-10-13T09:20:49.126Z");
const NOW = Date.parse("2026-10-13T09:52:00.000Z");
const LINE = `${JOB_NOTICE_PREFIX}${JOB} ended at ${clockTime(ENDED)} with no report`;

const said = (text: string, at: number): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at }) as ThreadMessage;
const report = (at: number): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${JOB}]\n\nI pushed it again.`, timestamp: at }) as ThreadMessage;
const reply = (at: number): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text: "Nothing is needed." }], stopReason: "stop", timestamp: at }) as ThreadMessage;
const job = (status: ChildAgent["status"], repliedSinceTask: boolean): ChildAgent =>
  ({ id: "sub-17eba397", label: JOB, sessionName: JOB, status, repliedSinceTask, lastActivityAt: ENDED });

async function server(messages: ThreadMessage[], busy: () => boolean) {
  const dir = await mkdtemp(join(tmpdir(), "no-report-once-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const prompts: string[] = [];
  const threads = {
    state: () => ({ messages }), async view() { return null; }, busy, running: () => false, setWait() {}, isLive: () => false,
    async restart() {}, async prompt(_id: string, input: { message: string }) { prompts.push(input.message); }, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe() { return () => {}; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async () => null, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 0,
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source, () => {});
  const roster = (children: ChildAgent[]) => (chats as unknown as { roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(new Map([[CHAT, children]]));
  const flush = async () => { for (let round = 0; round <= NO_REPORT_BUSY_TRIES + 1; round++) { await new Promise(resolve => setTimeout(resolve, 5)); await chats.settled(); } };
  return { chats, prompts, roster, flush };
}

test("no-report notice: a service restart does not tell the chat the same job end twice; a job message after the line lets a new end through", async () => {
  const messages = [said(LINE, ENDED + 97_000), reply(ENDED + 100_000)];
  const { chats, prompts, roster, flush } = await server(messages, () => false);
  await roster([job("done", true)]);
  await roster([job("running", false)]);
  await roster([job("done", false)]);
  await flush();
  assert.deepEqual(prompts, [], "the chat already holds this line and the job sent nothing after it");
  assert.equal(noticeStands(messages, JOB, LINE), true);
  messages.push(report(NOW - 60_000));
  assert.equal(noticeStands(messages, JOB, LINE), false, "a message from the job after the line: the next end is new");
  assert.equal(noticeStands(messages, "other job", LINE), true, "another job's message does not count");
  chats.close();
});

test("no-report notice: while the chat is mid-turn the check waits, so a report the daemon holds lands first; a chat busy past the tries still gets the line", async () => {
  let busy = true;
  const held = await server([reply(ENDED)], () => busy);
  await held.roster([job("done", true)]);
  await held.roster([job("running", false)]);
  await held.roster([job("done", false)]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(held.prompts, [], "no line while the chat's turn runs");
  await held.roster([job("done", true)]);
  busy = false;
  await held.flush();
  assert.deepEqual(held.prompts, [], "the held report landed: the job reported");
  held.chats.close();

  const stuck = await server([reply(ENDED)], () => true);
  await stuck.roster([job("done", true)]);
  await stuck.roster([job("running", false)]);
  await stuck.roster([job("done", false)]);
  await stuck.flush();
  assert.deepEqual(stuck.prompts, [LINE], `told after ${NO_REPORT_BUSY_TRIES} graces`);
  stuck.chats.close();
});
