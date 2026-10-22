// The dm-replies clean room judges what the owner got: a tell_owner call the tool refused (the long-reply check, c18 and c104) or held as a
// note never reached him, so the judge leaves it out, and the resent short text is the one it reads.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toldCalls } from "../scripts/clean-room/dm-replies.ts";
import { LONG_REPLY_MARK } from "../src/shared/reply-lint.ts";
import { TELL_OWNER_HELD } from "../src/shared/chat-feed.ts";

const line = (clock: string, message: Record<string, unknown>): string =>
  JSON.stringify({ type: "message", timestamp: `2026-10-22T${clock}Z`, message: { timestamp: Date.parse(`2026-10-22T${clock}Z`), ...message } });
const call = (clock: string, id: string, text: string): string =>
  line(clock, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }] });
const result = (clock: string, id: string, text: string, isError: boolean): string =>
  line(clock, { role: "toolResult", toolCallId: id, toolName: "tell_owner", isError, content: [{ type: "text", text }] });

test("a refused or held tell_owner call is left out of the judged calls", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dm-replies-")), "chat.jsonl");
  writeFileSync(file, [
    line("10:00:00", { role: "user", content: [{ type: "text", text: "how is it going?" }] }),
    call("10:00:10", "a", "long draft"), result("10:00:11", "a", `${LONG_REPLY_MARK}, with 168 words in all.`, true),
    call("10:00:20", "b", "held note"), result("10:00:21", "b", `${TELL_OWNER_HELD}. The owner did not start this turn.`, false),
    call("10:00:30", "c", "All three are in, see p12."), result("10:00:31", "c", "Sent.", false),
  ].join("\n"));
  assert.deepEqual(toldCalls(file).map(told => told.text), ["All three are in, see p12."]);
});
