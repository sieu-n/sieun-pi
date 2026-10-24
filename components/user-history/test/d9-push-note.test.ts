// On 10-24 the 08:03Z d9 push to one chat read as the owner's message: the feed drew it as his bubble and d11 counted it as his unanswered burst.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { pushTag, pushTells } from "../scripts/duties/chat-system.ts";
import { chatLines, ownerTyped, serverNote } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = Date.parse;
const push = `${pushTag(at("2026-10-24T08:03:00Z"))} The chat system duty (d9) found these in your chat: chat-2572: Check-in read off target in its last run.`;

test("a d9 push the duty builds is a d9 server note, not a message the owner typed", () => {
  assert.equal(pushTag(at("2026-10-24T08:03:12Z")), "[d9 push 2026-10-24T08:03Z]");
  assert.equal(serverNote(push), "d9");
  assert.equal(ownerTyped({ role: "user", content: [{ type: "text", text: push }], timestamp: at("2026-10-24T08:03:00Z") } as ThreadMessage), false);
  const tells = pushTells([{ chat: "c", goals: [], steps: [{ id: "p3", text: "a step" }], duties: [], upkeep: [] }] as never, pushTag(at("2026-10-24T08:03:00Z")));
  assert.equal(serverNote(tells[0]!.text), "d9");
});

test("the feed draws no owner bubble for a d9 push and folds the chat's plain answer to it", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "status?" }], timestamp: at("2026-10-24T08:00:00Z") },
    { role: "assistant", content: [{ type: "text", text: "all green" }], stopReason: "stop", timestamp: at("2026-10-24T08:01:00Z") },
    { role: "user", content: [{ type: "text", text: push }], timestamp: at("2026-10-24T08:03:00Z") },
    { role: "assistant", content: [{ type: "text", text: "on it" }], stopReason: "stop", timestamp: at("2026-10-24T08:04:00Z") },
  ] as unknown as ThreadMessage[];
  const lines = chatLines(messages).filter(line => line.kind === "user" || line.kind === "agent").map(line => [line.kind, (line as { text: string }).text]);
  assert.deepEqual(lines, [["user", "status?"], ["agent", "all green"]]);
});

const chats = { answered: "01a00000-0000-7000-8000-000000000001", pushed: "01a00000-0000-7000-8000-000000000002" };
function session(id: string, rows: [string, Record<string, unknown>][]): string {
  let n = 0;
  return [JSON.stringify({ type: "session", id, version: CURRENT_SESSION_VERSION, timestamp: "2026-10-24T00:00:00Z", cwd: "/" }),
    ...rows.map(([time, message]) => JSON.stringify({ type: "message", id: `e${++n}`, parentId: n > 1 ? `e${n - 1}` : null, timestamp: time, message: { ...message, timestamp: at(time) } }))].join("\n") + "\n";
}

test("d11 counts no unanswered burst for a d9 push nobody answered, and still counts the owner's own", () => {
  const home = mkdtempSync(join(tmpdir(), "d11-d9-push-"));
  try {
    const data = join(home, "data");
    mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
    mkdirSync(join(data, "owner-messages"), { recursive: true });
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
    writeFileSync(join(home, ".prime/agent/sessions", `${chats.answered}.jsonl`), session(chats.answered, [["2026-10-24T08:00:00.000Z", user("are you there?")]]));
    writeFileSync(join(home, ".prime/agent/sessions", `${chats.pushed}.jsonl`), session(chats.pushed, [["2026-10-24T08:03:00.000Z", user(push)]]));
    writeFileSync(join(data, "chats.json"), JSON.stringify({ ids: [chats.answered, chats.pushed] }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CHAT_DATA_DIR: data, OUTPUT_FILE: join(home, "out.json") };
    delete env.LAST_RUNS_FILE;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/duties/owner-messages.ts", "--end", "2026-10-24T10:00:00Z"], { env, cwd: join(import.meta.dirname, "..") });
    const output = JSON.parse(readFileSync(env.OUTPUT_FILE!, "utf8")) as { metrics: Record<string, number>; flagged: { kind: string; chat: string }[] };
    assert.equal(output.metrics.unanswered_bursts, 1);
    assert.deepEqual(output.flagged.filter(item => item.kind === "unanswered").map(item => item.chat), [chats.answered]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
