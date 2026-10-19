// 10-19: chats sent the owner 597 messages in a day and 469 of them came on turns he did not start (job reports, other threads, check-ins,
// [job] notices, wakes), so his feed was a long list of relays (c117). A tell_owner call on such a turn names its case or stays a note.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn, WAKE_NOTE, withWakeNotes } from "../src/chat-guard.ts";
import { chatLines, ownerMessageId, TELL_OWNER_HELD } from "../src/shared/chat-feed.ts";
import type { AssistantMessage, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-19T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:deploy gate]\n\n${text}`, timestamp: at(clock) });
const said = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const tell = (id: string, args: Record<string, unknown>, clock: string): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: args }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as AssistantMessage;
const result = (id: string, text: string, clock: string): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: false, timestamp: at(clock) });

const asked = owner("fix the autovacuum stall in the deploy gate", "05:00:00");
const settled = [asked, said("The job deploy gate autovacuum fixes it.", "05:01:00")];

test("on a job report the owner did not start, a relay is held as a note and a named case reaches him", () => {
  const turn = tellTurn([...settled, job("taken, the stub case is in", "05:20:00")]);
  assert.equal(turn.owner, false);
  const relay = tellOwner({ text: "The job took the gate fix and wrote a stub case.", why: "update" }, turn);
  assert.equal(relay.kind, "held");
  assert.ok(relay.text.startsWith(TELL_OWNER_HELD));
  const bare = tellOwner({ text: "The job took the gate fix." }, turn);
  assert.equal(bare.kind, "held");
  assert.match(bare.text, /named no why/, "on 10-19 ops guy's finished Grafana cleanup went with no why, and the plain held answer did not get a second call");
  assert.doesNotMatch(relay.text, /named no why/);
  assert.equal(tellOwner({ text: "The gate fix is live.", why: "done" }, turn).kind, "held", "a case with no about stays a note");
  assert.deepEqual(tellOwner({ text: "The gate fix is live, the 12:16 stall case passes.", why: "done", about: "autovacuum stall fix" }, turn),
    { kind: "sent", text: TELL_OWNER_DONE });
  assert.equal(tellOwner({ text: "The gate fix is live.", reply_to: ownerMessageId(asked.timestamp) }, turn).kind, "sent", "a reply_to his message is an answer");
  assert.equal(tellOwner({ text: "The gate fix is live.", reply_to: "zzz" }, turn).kind, "held");
  assert.equal(tellOwner({ text: " ", why: "done", about: "x" }, turn).kind, "refused");
});

test("on the owner's turn every call reaches him, also when a job report joins that turn", () => {
  const ownTurn = tellTurn([...settled, owner("is it live?", "05:30:00")]);
  assert.equal(ownTurn.owner, true);
  assert.equal(tellOwner({ text: "Not yet, the land runs now." }, ownTurn).kind, "sent");
  const running = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: {} }], stopReason: "toolUse", timestamp: at("05:30:10") } as unknown as ThreadMessage;
  const joined = tellTurn([...settled, owner("is it live?", "05:30:00"), running, job("land 48 is green", "05:31:00")]);
  assert.equal(joined.owner, true);
  const retry = owner("[check-in] Your last turn failed at 05:40 (429). The owner's message is still unanswered: \"is it live?\". Answer it first.", "05:45:00");
  assert.equal(tellTurn([...settled, retry]).owner, true);
  const stopped = { role: "assistant", content: [], stopReason: "aborted", timestamp: at("05:31:00") } as unknown as ThreadMessage;
  const restart = owner("[check-in] Your last turn failed at 05:31 (aborted). Re-check the board and continue.", "05:33:00");
  assert.equal(tellTurn([...settled, owner("is it live?", "05:30:00"), stopped, restart]).owner, true, "a restart after an aborted owner turn is still his");
  assert.equal(tellTurn([...settled, job("taken", "05:20:00"), said("noted", "05:20:30"), restart]).owner, false);
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "429", timestamp: at("05:31:00") } as unknown as ThreadMessage;
  const checkIn = owner("[check-in] Check-in: could not reach job idle ram drop, so start a job in its place.", "05:32:00");
  assert.equal(tellTurn([...settled, owner("is it live?", "05:30:00"), said("Yes, since 05:10.", "05:30:30"), checkIn]).owner, false);
  assert.equal(tellTurn([...settled, owner("is it live?", "05:30:00"), failed, checkIn, tell("t9", { text: "Not yet." }, "05:34:00")]).owner, true,
    "his message has no answer yet, so the call that answers it goes out");
});

test("the feed shows a held call in the turn's notes and a sent one as a bubble", () => {
  const lines = chatLines([...settled, job("taken", "05:20:00"),
    tell("t1", { text: "The job took the gate fix.", why: "update" }, "05:20:10"), result("t1", `${TELL_OWNER_HELD}. The owner did not start this turn.`, "05:20:11"),
    tell("t2", { text: "The gate fix is live.", why: "done", about: "autovacuum stall fix" }, "05:20:20"), result("t2", TELL_OWNER_DONE, "05:20:21")]);
  const told = lines.flatMap(line => line.kind === "agent" && line.told ? [line.text] : []);
  assert.deepEqual(told, ["The gate fix is live."]);
  assert.ok(lines.some(line => line.kind === "notes" && line.text === "The job took the gate fix."));
});

test("each wake-up in the model's view carries the note, and the owner's messages do not", () => {
  const notice = owner("[job] deploy gate autovacuum ended at 05:10 with no report", "05:10:00");
  const retry = owner("[check-in] Your last turn failed at 05:11 (aborted). Re-check the board and continue.", "05:12:00");
  const view = withWakeNotes([asked, job("taken", "05:05:00"), notice, retry]);
  assert.ok(view);
  const noted = view.map(message => JSON.stringify(message).includes(WAKE_NOTE));
  assert.deepEqual(noted, [false, true, true, false]);
});
