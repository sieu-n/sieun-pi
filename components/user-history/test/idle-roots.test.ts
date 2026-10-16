import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { ChatAgent, ChatBoard, PlanItem, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

/**
 * A create_session root is its own worker. On 10-14 at 12:39Z 8 roots the chats started sat idle with their report in, 2.81 GB together
 * (crawler release driver, ci release driver, heavy demand remeasure, watchlist all green, land 35 crawler pushes, ops release driver, engage
 * frozen thaw, harness footprint fix), and the 12:19Z service start reloaded 13 root jobs, each reload a new Python kernel.
 */
const START = Date.parse("2026-10-14T12:00:00Z");
const BRIEF = 'You are the job "crawler release driver" of the chat "Crawler VP". Watch land 35 and promote 10.';
const REPORT = "Land 35 is green and promote 10 is on prod; nothing is left on my side.";
const root = (sessionId: string, name: string, state: ChatAgent["state"] = "idle", quietMin = 61): ChatAgent =>
  ({ key: `thread:${sessionId}`, sessionId, name, job: `session:${sessionId}`, sender: name, link: "root", state, steps: [],
    lastActivityAt: new Date(START - quietMin * 60_000).toISOString() });
const said = (name: string): ThreadMessage =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from ${name}]\n${REPORT}`, display: true, timestamp: START - 61 * 60_000 }) as ThreadMessage;

async function setup(agents: ChatAgent[], plan: PlanItem[] = [], duty: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "idle-roots-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  for (const agent of agents) await writeFile(join(dir, "sessions", `${agent.sessionId}.jsonl`), [JSON.stringify({ type: "session", id: agent.sessionId }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: BRIEF }] } })].join("\n") + "\n");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  for (const agent of agents) await loads.set(agent.sessionId!, "b1");
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set("c1", agents.map(agent => said(agent.sender)));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = START;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan };
  const rows = (): SessionRow[] => [row("c1", new Date(START).toISOString(), { chat: true, agents })];
  const chats = new Chats(index, threads, async id => ({ lifecycle: "live", sessionFile: join(dir, "sessions", `${id}.jsonl`) }), "b2", loads,
    { ...source(dir, { c1: board }, () => now, rows), dutyJobs: async () => duty,
      resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async () => {} } }, line => lines.push(line));
  await chats.adopt();
  threads.fire().live("c1", []);
  await chats.settled();
  const sweep = async (at: number) => { now = at; await chats.tick(); await chats.settled(); };
  return { dir, chats, threads, calls, lines, sweep };
}

test("a reported root quiet past PARK_IDLE_MS that no open step names is saved and archived, and it is not reloaded at a service start", async () => {
  const { dir, chats, threads, calls, lines, sweep } = await setup([root("r1", "crawler release driver")]);
  await sweep(START);
  assert.deepEqual(threads.reloaded, [], "a reload would start a new Python kernel in a root that is done");
  assert.ok(calls.includes("archive r1"), calls.join("\n"));
  const path = join(dir, "job-resumes", "c1", "r1.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual([saved.brief, saved.report, saved.job], [BRIEF, REPORT, "crawler release driver"]);
  assert.ok(!calls.some(call => call.startsWith("notice")), calls.join("\n"));
  assert.ok(lines.some(line => line.startsWith("chat c1: archived idle root crawler release driver (quiet 61 min)")), lines.join("\n"));
  chats.close();
});

// 10-16 at 06:0x KST: 19 finished jobs waited out the old 60 min quiet with their workers loaded, and the hour had 12 harness minutes.
test("a reported root goes as soon as its report is in, and is kept while an open step names it, it waits on an answer, it is a duty run, or its session runs a tool call", async () => {
  const step: PlanItem = { id: "p7", text: "Build: land 35", status: "doing", job: "land 35 crawler pushes", children: [] };
  const agents = [root("r1", "ops release driver", "idle", 1), root("r2", "land 35 crawler pushes"), root("r3", "ci release driver", "waiting"),
    root("r4", "check-in Crawler VP 20:46"), root("r5", "heavy demand remeasure")];
  const { chats, threads, calls, sweep } = await setup(agents, [step], ["r4"]);
  threads.sessionBusy.add("r5");
  await sweep(START);
  assert.deepEqual(calls.filter(call => call.startsWith("archive")), ["archive r1"], "1 min quiet with its report in is enough");
  threads.sessionBusy.delete("r5");
  await sweep(START + 30_000);
  assert.deepEqual(calls.filter(call => call.startsWith("archive")), ["archive r1"], "the next look is one minute later");
  await sweep(START + 61_000);
  assert.deepEqual(calls.filter(call => call.startsWith("archive")), ["archive r1", "archive r5"], "r5 runs nothing now");
  chats.close();
});
