// Run-1 to run-3 of the c104 long-reply clean room ended open on 10-22 and 10-23 at their 4 h window ends, since the chat's jobs took 3.4 h and
// 3.5 h to report through account limit pauses, so a dm-replies collect now judges each pass and ends the run at its first pass or fail. Run-4
// went void at 47 min on a message from its own check-in, "check-in box questions 22 20", so the judge counts the chat's duty jobs as its own. In
// run-5 the check-in finished the disk step for a job held in the account queue, so its report counts as one of the three.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { FOLLOW_UP, TASK } from "../scripts/clean-room/dm-replies.ts";

const at = (clock: string): string => `2026-10-23T${clock}.000Z`;
const user = (clock: string, text: string): string =>
  JSON.stringify({ type: "message", timestamp: at(clock), message: { role: "user", timestamp: Date.parse(at(clock)), content: [{ type: "text", text }] } });
const tell = (clock: string, id: string, text: string): string[] => [
  JSON.stringify({ type: "message", timestamp: at(clock), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }] } }),
  JSON.stringify({ type: "message", timestamp: at(clock), message: { role: "toolResult", toolCallId: id, toolName: "tell_owner", isError: false, content: [{ type: "text", text: "Sent." }] } }),
  JSON.stringify({ type: "message", timestamp: at(clock), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }),
];
const report = (clock: string, job: string): string => JSON.stringify({ type: "custom_message", timestamp: at(clock), customType: "agent_message",
  content: `[agent-message from child:${job}] ${job} is done, the answer is on its step.`, details: { fromRelationship: "child" } });

test("a dm-replies collect ends the run at its first pass, long before its window ends", async () => {
  const srv = createServer((request, response) => {
    request.resume();
    request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(request.method === "GET" ? JSON.stringify({ agents: [] }) : "{}"); });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "clean-room-verdict-"));
  const run = join(root, "clean-room", "c104-long-reply", "run-1");
  try {
    const data = join(root, "data"), sessions = join(root, ".prime/agent/sessions"), wiki = join(root, "Documents/Github/auto-sns-agent/apps/llm-wiki/content/notes");
    for (const dir of [run, join(data, "boards"), sessions, wiki]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(data, "configuration.json"), JSON.stringify({ csrfToken: "abc123", port: (srv.address() as AddressInfo).port, capability: "cap" }));
    writeFileSync(join(data, "check-in-settings.json"), "{}");
    writeFileSync(join(data, "service.log"), "");
    writeFileSync(join(wiki, "release-path.md"), "# Release path\n\n```mermaid\nflowchart LR\n  job --> main --> release\n```\n");
    writeFileSync(join(sessions, "chat-1.jsonl"), [
      user("01:00:00", TASK), ...tell("01:00:30", "a", "Three jobs are on it, and I'll message you once all three are in."),
      JSON.stringify({ type: "custom_message", timestamp: at("01:20:00"), customType: "agent_message",
        content: "[agent-message from sibling:check-in box questions 01 20] [replaceable: check-in report] The three questions stand at 1 of 3.", details: { fromRelationship: "sibling" } }),
      report("02:00:00", "duty failures"), report("02:10:00", "main commits"), 
      ...tell("03:00:30", "b", "All three are in, and the duty with the most failures is d7, see p2 to p4."),
      user("03:10:00", FOLLOW_UP), ...tell("03:20:00", "c", "Close, but a person runs release-chat after the push, see wiki:notes/release-path.md for the diagram."),
    ].join("\n") + "\n");
    writeFileSync(join(run, "criteria.md"), "a: at least 3 job messages reach the chat\n");
    writeFileSync(join(run, "run.json"), JSON.stringify({ scenario: "dm-replies", chat: { id: "chat-1", name: "box questions" }, fixtures: {}, sandbox: root, everyMs: 900_000,
      release: "release-test", board: "", seeds: [TASK, FOLLOW_UP], setupAt: 0, windowStart: 0 }));
    const until = new Date(Date.now() + 12 * 3_600_000).toISOString();
    await promisify(execFile)(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/clean-room/clean-room.ts"), "collect", "--run", run, "--until", until, "--every-s", "1"],
      { env: { ...process.env, HOME: root, AGENT_CHAT_DATA_DIR: data, CLEAN_ROOM_SESSION: "", SIEUN_PI_HOSTS: join(root, "no-hosts.json") }, timeout: 60_000 });

    assert.match(readFileSync(`${run}.pass.md`, "utf8"), /run-1: pass/);
    assert.ok(!existsSync(run), "the run is torn down");
  } finally {
    rmSync(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => srv.close(error => error ? reject(error) : resolve()));
  }
});
