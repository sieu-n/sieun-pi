// Clean-room carried-wait run-3 on 10-24 read void for two senders. Its own root job "disk free sampling 2" reported its 12 readings to the
// chat as a sibling at 16:59:20Z, which is the system at work, and the AI harness developer environment VP thread sent the chat "fixed in
// sieun-pi 9cc887bc" at 15:46:07Z, which is someone stepping in. The agents list held both, the VP with link "message", and dc76a413 let both
// through until the judge counted only agents with link subagent or root, by session id. The judge admits the first and keeps the second.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatAgent, ChatBoard } from "../src/shared/types.ts";
import type { RunState } from "../scripts/clean-room/session-read.ts";
import type { Delivery } from "../scripts/clean-room/unrelated-ci-wait.ts";

const home = mkdtempSync(join(tmpdir(), "carried-wait-judge-"));
process.env.HOME = home;
const { judge, TASK } = await import("../scripts/clean-room/carried-wait.ts");

const CHAT = "01a16e1d-6592-73c6-9a96-81184bf35e5a";
const JOB = "01a16e8a-0000-7000-8000-000000000002";
const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const START = Date.parse("2026-10-24T13:33:31Z");
const at = (iso: string): string => new Date(Date.parse(iso)).toISOString();
const message = (iso: string, role: string, content: unknown) => ({ type: "message", timestamp: at(iso), message: { role, content } });
const sibling = (iso: string, name: string, id: string, text: string) => ({ type: "custom_message", timestamp: at(iso), customType: "agent_message",
  content: text, details: { from: { sessionId: id, sessionName: name }, fromRelationship: "sibling" } });

function run(name: string, lines: readonly object[], jobLines: readonly object[] = []): { dir: string; state: RunState } {
  const dir = join(home, name);
  mkdirSync(join(dir, "boards"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: at("2026-10-24T13:34:00Z"), todos: [], plan: [
    { id: "p1", text: "Show how free space on / moves over 3 hours", status: "doing", children: [] }] };
  writeFileSync(join(dir, "boards", "000001.json"), JSON.stringify(board));
  const agents: ChatAgent[] = [{ key: `thread:${JOB}`, sessionId: JOB, name: "disk free sampling 2", job: "disk free sampling 2", sender: "disk free sampling 2",
    link: "root", state: "working", steps: ["p2"] },
    { key: `thread:${VP}`, sessionId: VP, name: "AI harness developer environment VP", job: "AI harness developer environment VP",
      sender: "AI harness developer environment VP", link: "message", state: "working", steps: [] }];
  writeFileSync(join(dir, "agents", `${START + 60_000}.json`), JSON.stringify(agents));
  writeFileSync(join(dir, "runs.jsonl"), "");
  mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
  writeFileSync(join(home, ".prime/agent/sessions", `${CHAT}.jsonl`), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  writeFileSync(join(home, ".prime/agent/sessions", `${JOB}.jsonl`), [message("2026-10-24T13:35:00Z", "user", "Sample free space on / every 15 minutes for 3 hours."),
    ...jobLines].map(line => JSON.stringify(line)).join("\n") + "\n");
  const state: RunState = { scenario: "carried-wait", chat: { id: CHAT, name: "root disk readings" }, fixtures: {}, sandbox: home, everyMs: 30 * 60_000,
    release: "release-test", board: "", seeds: [TASK], setupAt: START, windowStart: START, until: START + 4 * 3_600_000 };
  return { dir, state };
}
const base = [message("2026-10-24T13:33:31Z", "user", TASK), message("2026-10-24T13:34:00Z", "assistant", [{ type: "text", text: "Starting the sampling job." }])];
const report = sibling("2026-10-24T16:59:20Z", "disk free sampling 2", JOB, "All 12 readings of free space on / are in.");
const outside = sibling("2026-10-24T15:46:07Z", "AI harness developer environment VP", VP, "From the AI harness chat VP: fixed in sieun-pi 9cc887bc.");
const impostor = sibling("2026-10-24T16:10:00Z", "disk free sampling 2", "01a16e8a-0000-7000-8000-00000000dead", "Readings look fine, carry on.");
const clean: Delivery = { logCovered: true, steers: [], resumes: [], pushesRead: true, pushes: [] };
const f = (text: string): string => text.split("\n").find(line => line.startsWith("- f "))!;

test("the chat's own root job reporting as a sibling is the system at work", () => {
  const { dir, state } = run("own", [...base, report]);
  const line = f(judge(dir, state, START + 5 * 3_600_000, clean).text);
  assert.match(line, /^- f met/, line);
});

test("another chat's thread messaging the test chat is an intervention, and the run is void", () => {
  const { dir, state } = run("outside", [...base, outside, report]);
  const verdict = judge(dir, state, START + 5 * 3_600_000, clean);
  const line = f(verdict.text);
  assert.match(line, /^- f not met/, line);
  assert.match(line, /AI harness chat VP/);
  assert.doesNotMatch(line, /All 12 readings/);
  assert.equal(verdict.verdict, "void");
});

test("a sender that only shares the name of the chat's job is an intervention, since names never count", () => {
  const { dir, state } = run("impostor", [...base, impostor, report]);
  const line = f(judge(dir, state, START + 5 * 3_600_000, clean).text);
  assert.match(line, /^- f not met/, line);
  assert.match(line, /carry on/);
  assert.doesNotMatch(line, /All 12 readings/);
});

const steer = message("2026-10-24T15:20:00Z", "user", "[check-in] Report your reading count to the chat now.");
const push = message("2026-10-24T15:30:00Z", "user", "[d9 push 2026-10-24T15:30Z] The chat system duty (d9) found these in your chat: p3.");
const later = START + 5 * 3_600_000;

test("a d9 push the service wraps as its own note is someone stepping in", () => {
  const { dir, state } = run("d9", [...base, push]);
  const line = f(judge(dir, state, later, clean).text);
  assert.match(line, /^- f not met/, line);
  assert.match(line, /d9 push/);
});

test("a check-in steer in the chat's job with no steer line to trace it to the chat leaves f unknown, not met", () => {
  const { dir, state } = run("untraced", base, [steer]);
  const line = f(judge(dir, state, later, clean).text);
  assert.match(line, /^- f not reached yet: unknown/, line);
  const uncovered = f(judge(dir, state, later, { ...clean, logCovered: false }).text);
  assert.match(uncovered, /service\.log does not cover the window/);
});

test("a check-in steer in the chat's job counts as its own only by a steer line of this chat for that job", () => {
  const mine = { chat8: CHAT.slice(0, 8), job: "disk free sampling 2", act: "steered" as const, raw: `chat ${CHAT.slice(0, 8)}: check-in job steered job disk free sampling 2` };
  const { dir, state } = run("traced", base, [steer]);
  assert.match(f(judge(dir, state, later, { ...clean, steers: [mine] }).text), /^- f met/);
  const theirs = { ...mine, chat8: "01a162bc", raw: "chat 01a162bc: check-in job steered job disk free sampling 2" };
  assert.match(f(judge(dir, state, later, { ...clean, steers: [theirs] }).text), /^- f not met/);
});

test("a subagent of the chat's job, by the parent its session header records, reports to that job as the trial's own (run-4, 10-24)", () => {
  const WRITER = "01a16f95-b211-758c-8541-498f6cbe20c9";
  const { dir, state } = run("descendant", base, [{ type: "custom_message", timestamp: at("2026-10-24T16:38:42Z"), customType: "agent_message",
    content: "The page is up.", details: { from: { sessionId: WRITER, sessionName: "free-space-page-writer" }, fromRelationship: "child" } }]);
  const folder = join(home, ".prime/agent/session-artifacts", JOB, "sub-ee61925a");
  const header = (parent: string) => JSON.stringify({ type: "session", version: 3, id: WRITER, timestamp: at("2026-10-24T16:24:03Z"), parentSession: parent }) + "\n";
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${WRITER}.jsonl`), header(`/home/sieun/.prime/agent/sessions/${JOB}.jsonl`));
  assert.match(f(judge(dir, state, later, clean).text), /^- f met/);
  writeFileSync(join(folder, `${WRITER}.jsonl`), header(`/home/sieun/.prime/agent/sessions/${VP}.jsonl`));
  assert.match(f(judge(dir, state, later, clean).text), /^- f not met/, "a parent outside the trial is no ancestry");
  rmSync(folder, { recursive: true, force: true });
  assert.match(f(judge(dir, state, later, clean).text), /^- f not met/, "a sender with no session file has no recorded parent");
});

test.after(() => rmSync(home, { recursive: true, force: true }));
