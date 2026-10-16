import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { outline } from "../src/client/prompt-parts.ts";
import { nextBriefView, userSource } from "../src/prompt-view.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { DUTY_BRIEF, type PromptPart } from "../src/shared/prompt-view.ts";

const host: DutyJobHost = {
  async chat(chatId): Promise<DutyChat | null> { return chatId === "chat1" ? { id: chatId, name: "dev VP", cwd: "/repo", board: `/boards/${chatId}.json` } : null; },
  async working() { return false; },
  async start() { throw new Error("no job starts in this test"); },
  async retire() {},
};

test("nextBrief: the brief a duty's next run sends, with the precheck's parts named; null for an unknown duty or chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-brief-"));
  try {
    const store = new DutyStore(dir);
    const now = new Date(2026, 9, 16, 9, 0).getTime();
    await store.update("chat1", duties => { duties.push(parseDutyInput({ name: "Whole system", ownerWords: "keep it fast", goal: "The Mac stays usable.", onMiss: "Start a fix job.",
      metrics: [{ key: "usable", label: "Usable minutes", op: ">=", target: 95, unit: "%", headline: true }], schedule: { kind: "daily", at: "10:00" },
      precheck: { command: ["node", "-e", "0"], cwd: dir } }, "d1", now)); });
    const duties = new Duties(store, { isChat: async id => id === "chat1", jobs: host, now: () => now, tickMs: 0 });
    const brief = await duties.nextBrief("chat1", "d1");
    assert.ok(brief);
    assert.match(brief.text, /^# whole system dev VP 10:00: the Whole system duty of the chat "dev VP"/);
    assert.match(brief.text, /> keep it fast/);
    assert.match(brief.text, /Measured against the targets: <the precheck's measure against the targets, taken when the run starts>/);
    assert.equal(userSource(brief.text).label, DUTY_BRIEF, "the job's first message reads as the duty brief");
    assert.equal(await duties.nextBrief("chat1", "d9"), null);
    assert.equal(await duties.nextBrief("chat2", "d1"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("duty brief: a run's brief and a check-in job's brief read as the duty brief, and the view lists it first, before the system prompt", () => {
  assert.equal(userSource('# check-in dev VP 08:38: the Check-in duty of the chat "dev VP"\n\nYou are').label, DUTY_BRIEF);
  assert.equal(userSource('# check-in dev VP 08:38: the check-in of the chat "dev VP"\n\nYou are').label, DUTY_BRIEF);
  assert.equal(userSource("# Notes\nship it").label, "Owner");
  const part = (id: string, label: string, tokens: number, role?: PromptPart["role"]): PromptPart =>
    ({ id, kind: role ? "message" : "system", label, source: "s", ...(role ? { role } : {}), text: "x", tokens });
  const table = outline({ threadId: "j1", sessionFile: "/j1.jsonl", origin: { kind: "rebuild", reason: "r" }, totalTokens: 600,
    parts: [part("p0", "Base system prompt", 300), part("p1", DUTY_BRIEF, 200, "user"), part("p2", "Tool result: bash", 100, "toolResult")] });
  assert.deepEqual(table.lead?.parts.map(entry => entry.id), ["p1"]);
  assert.deepEqual(table.groups.map(group => group.label), ["Tool result"]);
  assert.deepEqual([table.messageParts, table.messageTokens], [1, 100]);
  const next = nextBriefView("chat1", "d1", { text: "# brief", at: 0 }, "Next run of Whole system");
  assert.equal(next.origin.kind, "rebuild");
  assert.deepEqual(outline(next).lead?.parts.map(entry => entry.text), ["# brief"]);
});
