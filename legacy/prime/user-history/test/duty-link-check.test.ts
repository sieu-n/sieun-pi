// Job "d9 stuck duties root cause 10-23", 10-22 about 20:10Z: the AI harness chat's p919 linked d5/tools_off, a metric d5 no longer had, so
// d9 read d5 red with no fix step. The board refuses a duty link that names no metric or reading of the chat's duties, and lists the real keys.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoardStore } from "../src/chat-board-store.ts";

const chat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const d5 = { id: "d5", name: "Skills and tools", ownerWords: "x", goal: "x", onMiss: "x", status: "active", createdAt: 1, updatedAt: 1, runCount: 0,
  schedule: { kind: "every", minutes: 60 }, precheck: { command: ["true"], cwd: "/", timeoutMs: 1000 },
  metrics: [{ key: "skills_or_tools_to_fix", label: "x", op: "<=", target: 0, headline: true }], readings: [{ key: "tool_calls_24h", label: "x" }] };

async function withStore(run: (store: BoardStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duty-link-"));
  try {
    await mkdir(join(dir, "duties"), { recursive: true });
    await writeFile(join(dir, "duties", chat + ".json"), JSON.stringify({ version: 1, duties: [d5] }));
    await run(new BoardStore(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("plan_add refuses d5/tools_off and names d5's real keys", () => withStore(async store => {
  await assert.rejects(store.apply(chat, [{ op: "plan_add", text: "Fix tools", duty: "d5/tools_off" }], "agent"),
    /d5\/tools_off names tools_off, which d5 "Skills and tools" does not measure; its metric keys are skills_or_tools_to_fix, tool_calls_24h/);
  assert.equal((await store.read(chat))?.plan.length ?? 0, 0);
}));

test("plan_add and plan_update refuse a duty the chat does not have", () => withStore(async store => {
  await assert.rejects(store.apply(chat, [{ op: "plan_add", text: "Fix", duty: "d7/x" }], "agent"), /names d7, which is no duty of this chat; its duties are checkin "Check-in" \(goal_gaps/);
  await store.apply(chat, [{ op: "plan_add", text: "Fix tools", duty: "d5/skills_or_tools_to_fix" }], "agent");
  const id = (await store.read(chat))!.plan[0]!.id;
  await assert.rejects(store.apply(chat, [{ op: "plan_update", id, duty: "checkin/stalled_steps" }], "agent"), /checkin "Check-in" does not measure/);
  await store.apply(chat, [{ op: "plan_update", id, duty: "d5/tool_calls_24h" }, { op: "plan_update", id, duty: "checkin/goal_gaps" }], "agent");
}));

test("plan_set keeps an old stale link and the write flags it, while a new stale link is refused", () => withStore(async store => {
  await store.apply(chat, [{ op: "plan_add", text: "Fix tools", duty: "d5/skills_or_tools_to_fix" }], "agent");
  const file = join(store.dir, chat + ".json");
  const board = (await store.read(chat))!;
  await writeFile(file, JSON.stringify({ ...board, plan: [{ ...board.plan[0]!, duty: "d5/tools_off" }] }));
  const id = board.plan[0]!.id;
  const { summaries } = await store.apply(chat, [{ op: "plan_set", items: [{ id, text: "Fix tools", duty: "d5/tools_off" }] }], "agent");
  assert.match(summaries.join("\n"), new RegExp(`${id} "Fix tools" has a stale duty link: .*its metric keys are skills_or_tools_to_fix`));
  await assert.rejects(store.apply(chat, [{ op: "plan_set", items: [{ id, text: "Fix tools", duty: "d5/tools_gone" }] }], "agent"), /does not measure/);
}));
