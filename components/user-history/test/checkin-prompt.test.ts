import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as checkin from "../src/chat-checkin.ts";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { CHECK_IN_MS } from "../src/checkin-settings.ts";
import type { DutyJobRef } from "../src/shared/chat-duties.ts";
import type { ChatBoard } from "../src/shared/types.ts";

/**
 * The check-in prompt after the owner's 10-16 words: "it should be based on metrics, more sophisticated shit ... 지금 완전 개 무쓸모라고" (c90).
 * Replays Crawler VP at 22:00Z on 10-15 (test/fixtures/checkin-goal-push-crawler-vp-1015.json): the brief carries the owner's sentence, where
 * the board and conversation are, each goal's number, gap, trend, days to target and pace, and the actions due, with no stock rule lines and
 * no list of step ids.
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const NOW = Date.parse("2026-10-15T22:00:00Z");
const board = JSON.parse(await readFile(new URL("./fixtures/checkin-goal-push-crawler-vp-1015.json", import.meta.url), "utf8")) as ChatBoard;
const facts: JobFact[] = [{ key: "j1", name: "virev query mcp design", state: "working", activityAt: NOW }];
const morning = { at: Date.parse("2026-10-15T06:50:00Z"), steps: {}, goals: { p71: { readings: [{ value: 10.17, at: Date.parse("2026-10-15T06:42:00Z") }], still: 0 } } };
const ID_LIST = /\b[pt]\d+\b(?:,?[ \t]+(?:and[ \t]+)?|[ \t]*[-/][ \t]*)[pt]\d+\b/;

async function brief(): Promise<{ brief: string; detail: string }> {
  const { checkInPrecheck, checkInPrecheckText, classCounts, convergenceMisses } = checkin;
  const checkInPrompt = (checkin as Record<string, unknown>).checkInPrompt as ((precheck: unknown, line: string | null) => string) | undefined;
  assert.equal(typeof checkInPrompt, "function", "the precheck builds the check-in prompt");
  const precheck = checkInPrecheck(morning, facts, board, NOW, { self: [CHAT, "Crawler VP"], everyMs: CHECK_IN_MS });
  const output = convergenceMisses(CHAT, precheck.steps, precheck, {}, CHECK_IN_MS, NOW);
  const dir = await mkdtemp(join(tmpdir(), "checkin-prompt-"));
  const briefs: string[] = [];
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "Crawler VP", cwd: "/repo", board: `/home/.prime/agent/browser-chat/boards/${chatId}.json` }; },
    async working() { return false; },
    async start(_chat, name, text): Promise<DutyJobRef> { briefs.push(text); return { id: "s1", name }; },
    async retire() {},
  };
  const duties = new Duties(new DutyStore(dir), { isChat: async () => true, jobs: host, tickMs: 0, now: () => NOW });
  await duties.checkIn(CHAT, { at: NOW, trigger: "schedule", everyMs: CHECK_IN_MS, output, classes: classCounts(precheck.steps),
    findings: checkInPrecheckText(precheck, facts, output.flagged, NOW),
    prompt: checkInPrompt!(precheck, "Check-in: restarted job census canary run, because nothing moved on their work.") } as Parameters<Duties["checkIn"]>[1]);
  duties.close();
  const text = briefs[0]!;
  const path = text.match(/is in (\S+\.flagged\.md)\./)?.[1];
  return { brief: text, detail: path ? await readFile(path, "utf8") : "" };
}

test("the check-in prompt: the owner's sentence, the chat's paths, each goal's number, gap, days to target and pace, and the actions due", async () => {
  const { brief: text, detail } = await brief();
  assert.match(text, /The owner's words for the check-in \(verbatim\):\n\n> check conversation and sync Plans to actual status, and resume tasks, nudge agents to achieve the goal\. be aggressive, poteto mode use subagents aggressively/);
  assert.match(text, /Its board is \/home\/\.prime\/agent\/browser-chat\/boards\/01a115e2-9544-7204-b8db-8ce4d5319048\.json, and its conversation is \/home\/\.prime\/agent\/sessions\/01a115e2-9544-7204-b8db-8ce4d5319048\.jsonl\./);
  assert.match(text, /## Goals\n- "Complete index of Instagram, Meta Ads and TikTok Shop \(owne…" \(p71\): Instagram Tier A indexed 14\.9 of 100%, 85\.1 points short; \+4\.73 points since 10-15 06:42Z, about 10 days to target at this rate, off pace; no live job owns it\./);
  assert.match(text, /## Due this run\n1\. Add a push step under p71 with duty "checkin\/goal_gaps" for "Complete index[^"]*", set its job to a live job of the goal or a new one, and send it this message:\n\n {3}Owner's words for p71/);
  assert.match(text, /\d\. The server already restarted job census canary run, because nothing moved on their work\. Check in this run that each one reported/);
  assert.match(text, /The full precheck, with every step and finding, is in \S+\.flagged\.md\./);
  assert.match(detail, /### Stuck steps|### Goals/, "the step findings stay in the detail file");
});

test("the check-in prompt has no stock rule lines, no step sections and no list of step ids (c80, c90)", async () => {
  const { brief: text } = await brief();
  for (const stock of [/Two hard gates hold/, /Never send anything outside/, /Split work by the job rules/, /Map the chat's work as a graph/, /### Stuck steps/,
    /### Steps whose class needs action/, /flagged items; the first/, /## Missed metrics/, /Act directly and ship/, /No cap, throttle/]) assert.doesNotMatch(text, stock);
  assert.doesNotMatch(text, ID_LIST);
  assert.ok(text.length < 6000, `${text.length} characters`);
});

test("the chat brief: the rule that hands real work to jobs says the first reply answers the owner's question with a number first (c52)", () => {
  const line = CHAT_BRIEF.find(entry => entry.includes("Any real task goes to a job"))!;
  assert.match(line, /Any real task goes to a job, after your first reply answers the owner's question with the number or fact you read in that minute/);
  assert.match(line, /a reply that only says a job will find out is no answer \(c52\)/);
  assert.equal(CHAT_BRIEF.filter(entry => entry.includes("(c52)")).length, 1, "one place says it");
});
