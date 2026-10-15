import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION } from "prime-agent";
import { loadRecord } from "../src/chat-brief.ts";
import type { ChatThreads } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import type { Said } from "../src/checkin-ops.ts";
import { decisionSteer } from "../src/decision-notes.ts";
import { IdIndex } from "../src/id-index.ts";
import { serverNote } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * c76, ops guy 10-15: at 05:41:44Z its turn sent the VP of CI a land order and at 07:43:29Z a "won't land" ruling on three runs, both in thread
 * messages only; the scratchpad gained no note until 08:27Z, after the owner asked "why don't you use the Plan scratchpad by the way?".
 */
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const VP_OF_CI = { activeSessionId: "6ee467f87e82", sessionId: "01a1180e-6567-747f-bf44-452520ebdd1b", sessionName: "VP of CI" };
const ORDER = "From ops guy, the order: our ops train lands the promtool glob c0008ee78d first, as its own small stack rebased onto the current tip, " +
  "with every covered per-file promtool block dropped, then re-reviewed and landed alone on green. Metal prefers the glob too.";
const WONT_LAND = "From ops guy: thanks. ci/vent-metal-r4, ci/vent-metal-r5 and ci/ops-train-16 are all superseded and won't land: our train is now " +
  "per-app stacks on tip 1dcf498bdb, and Vent rebuilds on our shared stack.";
const STATUS = "From ops guy: no newly superseded runs since my last list.";
const LINE = "[board] Decisions not on the scratchpad: your last turn sent a ruling and added no scratch note: to VP of CI at 05:41Z, " +
  "\"From ops guy, the order: our ops train lands the promtool glob c0008ee78d first, as its own small s\u2026\". " +
  "Add one dated scratch note for each decision this chat made, with a link to the thread or job (c76).";

let clock = Date.parse("2026-10-15T05:40:00Z");
const ended = (): Said => ({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: clock += 1000 });
const owner = (text: string): Said => ({ role: "user", content: [{ type: "text", text }], timestamp: clock += 1000 });
/** One ipython call that sent `texts` to the VP of CI, as the session file holds it. */
function send(texts: readonly string[], at = clock += 1000): Said[] {
  const id = `toolu_send_${at}`;
  return [{ role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: { code: "await snd(...)" } }], stopReason: "toolUse", timestamp: at },
    { role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text: "delivered\n" }], timestamp: at + 1,
      details: { sentAgentMessages: texts.map(message => ({ message, deliveryStatus: "delivered", receiverRole: "sibling", target: VP_OF_CI })) } }];
}
function scratch(refused = false): Said[] {
  const id = `toolu_board_${clock += 1000}`;
  return [{ role: "assistant", content: [{ type: "toolCall", id, name: "chat_board", arguments: { ops: [{ op: "scratch_add", text: "Decided 10-15 05:41Z: the promtool glob lands first." }] } }],
    stopReason: "toolUse", timestamp: clock },
    { role: "toolResult", toolCallId: id, isError: refused, content: [{ type: "text", text: refused ? "Refused." : "Board rev 900" }], timestamp: clock + 1 }];
}
const turn = (...parts: Said[][]): Said[] => [owner("[agent-message from sibling:VP of CI] which lands first?"), ...parts.flat(), ended()];
const before = (): Said[] => [owner("start"), ended()];

test("decision notes: a turn that sends a land order with no scratch note gets the [board] line (ops guy 10-15 05:41Z)", () => {
  clock = Date.parse("2026-10-15T05:41:40Z");
  const messages = [...before(), ...turn(send([ORDER], Date.parse("2026-10-15T05:41:44Z")))];
  assert.deepEqual(decisionSteer(messages), { at: clock, line: LINE });
  assert.equal(serverNote(LINE), "board", "the line is a server note, never the owner's words");
});

test("decision notes: no line when the turn's chat_board call added a scratch note, and a refused call adds none", () => {
  assert.equal(decisionSteer([...before(), ...turn(send([ORDER]), scratch())])?.line, null);
  assert.match(decisionSteer([...before(), ...turn(send([ORDER]), scratch(true))])?.line ?? "", /sent a ruling and added no scratch note/);
});

test("decision notes: a status message rules on nothing, and two rulings in one turn are both named", () => {
  assert.equal(decisionSteer([...before(), ...turn(send([STATUS]))])?.line, null);
  const line = decisionSteer([...before(), ...turn(send([ORDER]), send([WONT_LAND, STATUS]))])?.line ?? "";
  assert.match(line, /sent 2 rulings/);
  assert.match(line, /"\u2026ci\/ops-train-16 are all superseded and won't land: our train is now per-app stacks on tip 1dcf498bd\u2026"/);
});

test("decision notes: undefined while the turn runs or the tail does not reach its start; null once the line was sent", () => {
  const running = [...before(), owner("go"), ...send([ORDER])];
  assert.equal(decisionSteer(running), undefined);
  assert.equal(decisionSteer([...send([ORDER]), ended()]), undefined, "no turn end before it, so a scratch note may sit above the tail");
  assert.equal(decisionSteer([...before(), ...turn(send([ORDER])), owner(LINE)])?.line, null);
});

type Entry = { type: "message"; id: string; parentId: string | null; timestamp: string; message: Said };
test("decision notes: the chat server steers once per turn, from the session file, and not again after a restart", async () => {
  clock = Date.parse("2026-10-15T05:41:40Z");
  const dir = await mkdtemp(join(tmpdir(), "decision-notes-"));
  const file = join(dir, `${CHAT}.jsonl`);
  let parent: string | null = null;
  let count = 0;
  const entry = (message: Said): Entry => { const id = `e${count++}`; const next: Entry = { type: "message", id, parentId: parent, timestamp: new Date(message.timestamp ?? clock).toISOString(), message }; parent = id; return next; };
  const messages = [...before(), ...turn(send([ORDER]))];
  await writeFile(file, [JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: CHAT, timestamp: "2026-10-15T05:40:00Z", cwd: dir }),
    ...messages.map(message => JSON.stringify(entry(message)))].join("\n") + "\n");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  // The hub's projection drops a tool result's details.
  const transcript = messages.map(({ details: _, ...message }) => message as ThreadMessage);
  threads.transcripts.set(CHAT, transcript);
  threads.prompt = async (id: string, input: { message: string; mode: string }) => {
    calls.push(`${input.mode} ${id} ${input.message}`);
    const said = owner(input.message);
    transcript.push(said as ThreadMessage);
    await appendFile(file, JSON.stringify(entry(said)) + "\n");
  };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const start = () => new Chats(index, threads as unknown as ChatThreads, async () => ({ lifecycle: "live", sessionFile: file }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, {}));
  let chats = start();
  const idle = async (): Promise<string[]> => {
    threads.fire().idle(CHAT);
    await chats.settled();
    return calls.splice(0).filter(call => call.startsWith(`steer ${CHAT} [board] Decisions`)).map(call => call.slice(`steer ${CHAT} `.length));
  };
  assert.deepEqual(await idle(), [LINE]);
  assert.deepEqual(await idle(), [], "the same turn is judged once");
  chats.close();
  chats = start();
  assert.deepEqual(await idle(), [], "after a restart the line is in the session file");
  chats.close();
});
