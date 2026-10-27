// Owner's ask, 10-22 00:20Z: "prime-agent chat that have been running in the background become illedgible bring back a focus on agent messages by collapsing them, show maybe most recent message". The AI harness chat showed one row per wait, job message and stop, with senders as raw ids such as "0c8dc51ba931".
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogNames, chatFeed, chatLines, foldLabel, stampedItems, unreadCount, type ChatItem, type Fold } from "../src/shared/chat-feed.ts";
import { projectRow } from "../src/chat-catalog.ts";
import type { SessionRow, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-22T${clock}Z`);
const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const reply = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const relay = (from: string, text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from ${from}]\n\n${text}`, display: true, timestamp: at(clock) }) as ThreadMessage;
const failed = (error: string, clock: string): ThreadMessage => ({ role: "assistant", content: [], stopReason: "error", errorMessage: error, timestamp: at(clock) }) as unknown as ThreadMessage;
const stopped = (clock: string): ThreadMessage => ({ role: "assistant", content: [], stopReason: "aborted", timestamp: at(clock) }) as unknown as ThreadMessage;
const poolWait = (slot: string, clock: string): ThreadMessage =>
  failed(`Failed to resolve API key pi-pool: this session waits for its slot at 2026-10-22T${slot}.000Z. Try again in 5 minutes.`, clock);
const state = (messages: ThreadMessage[]) => ({ messages, streaming: null, wait: null });
const kinds = (items: ChatItem[]): string[] => items.map(item => item.kind);
const folds = (items: ChatItem[]): Fold[] => items.filter((item): item is Fold => item.kind === "fold");

test("waits, job messages and stops between two replies fold into one row with the latest line and a count", () => {
  const feed = chatFeed(state([
    owner("why is the feed so noisy?", "00:00:00"),
    reply("Looking.", "00:00:30"),
    relay("chat-057a", "landed the digest cache", "00:01:00"),
    poolWait("00:24:00", "00:01:10"),
    relay("child:babysitter", "PR 412 is green", "00:02:00"),
    stopped("00:02:10"),
    owner("[job] wiki dream ended with no report", "00:03:00"),
    poolWait("00:26:00", "00:03:10"),
    owner("and now?", "00:10:00"),
    reply("Folded.", "00:10:30"),
  ]));
  assert.deepEqual(kinds(feed), ["user", "agent", "fold", "user", "agent"]);
  const fold = folds(feed)[0]!;
  assert.deepEqual(fold.entries.map(entry => entry.kind), ["job", "job", "quiet", "job", "quiet"], "the earlier wait merged into the latest one");
  const label = foldLabel(fold);
  assert.equal(label.latest, `Waiting for a Claude account until ${hhmm(at("00:26:00"))}.`);
  assert.equal(label.count, "5 updates");
  assert.equal(label.names, "jobs, babysitter, chat-057a");
});

test("an error that ends the owner's turn stays visible until an answer follows it", () => {
  const asked = [owner("ship it", "01:00:00"), failed("Provider rate limit exceeded (rate_limit_error, 429)", "01:00:20")];
  const open = chatFeed(state([...asked, relay("chat-057a", "taken", "01:05:00"), stopped("01:05:10")]));
  assert.deepEqual(kinds(open), ["user", "notice", "fold"]);
  assert.equal(open[1]!.kind === "notice" && open[1]!.text, "Error: Provider rate limit exceeded (rate_limit_error, 429)");
  const answered = chatFeed(state([...asked, reply("Shipped.", "01:02:00")]));
  assert.deepEqual(kinds(answered), ["user", "fold", "agent"], "the chat went on and answered him");
  const agentTurn = chatFeed(state([relay("chat-057a", "taken", "01:05:00"), failed("Provider rate limit exceeded", "01:05:10")]));
  assert.deepEqual(kinds(agentTurn), ["fold"], "an error on a turn he did not start is background");
});

test("a relay from a live agent's 12-hex id reads as its catalog name", () => {
  const row = projectRow({ id: "0c8dc51ba931", activeSessionId: "0c8dc51ba931", sessionId: "01a16100-b7c0-74ad-b3fe-27e35eee408b", sessionName: "feed-scroll", cwd: "/x",
    lifecycle: "live", activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 3,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as unknown as Parameters<typeof projectRow>[0], undefined, 0);
  assert.equal(row.agent, "0c8dc51ba931");
  const saved: SessionRow = { ...row, id: "01a1164b-4a2d-742d-b27a-82f086ed0200", name: "AI harness developer environment VP" };
  delete saved.agent;
  const nameOf = catalogNames([row, saved]);
  const from = (messages: ThreadMessage[]): string[] => chatLines(messages, nameOf).flatMap(line => line.kind === "job" ? [line.from] : []);
  assert.deepEqual(from([
    relay("0c8dc51ba931", "scroll fix is in", "02:00:00"),
    relay("01a1164b-4a2d-742d-b27a-82f086ed0200", "go ahead", "02:01:00"),
    relay("34415a8288c4", "nobody lists me", "02:02:00"),
    relay("4dd1b45991e7", '[cross-host message from gpt sol (01a15f90-afb8-7434-814a-2e5fbcafb1ec) on mac; answer with agent_message.send(text, receiver_role="sibling", receiver_name="01a15f90-afb8-7434-814a-2e5fbcafb1ec")]\n\nOwner asks for ratios', "02:03:00"),
  ]), ["feed-scroll", "AI harness developer environment VP", "another thread", "gpt sol"]);
  assert.equal(chatLines([relay("4dd1b45991e7", "[cross-host message from gpt sol (01a15f90-afb8-7434-814a-2e5fbcafb1ec) on mac; answer with x]\n\nOwner asks for ratios", "02:03:00")]).map(line => line.kind === "job" && line.title)[0],
    "Owner asks for ratios", "a relay from another box shows its own first line, not the opener");
  assert.equal(catalogNames([row, saved]), nameOf, "the same names give the same function, so the feed is not built again on a sessions frame");
});

test("fold ids hold when an older page loads in front and when a new line lands at the bottom", () => {
  const older = [owner("first", "03:00:00"), reply("One.", "03:00:30"), relay("chat-057a", "a", "03:01:00"), poolWait("03:30:00", "03:01:10")];
  const newer = [owner("second", "03:10:00"), reply("Two.", "03:10:30"), relay("babysitter", "b", "03:11:00"), poolWait("03:40:00", "03:11:10"), stopped("03:11:20")];
  const page = folds(chatFeed(state(newer))).map(fold => fold.id);
  const whole = folds(chatFeed(state([...older, ...newer]))).map(fold => fold.id);
  assert.equal(page.length, 1);
  assert.deepEqual(whole.slice(-1), page);
  const grown = folds(chatFeed(state([...older, ...newer, relay("babysitter", "c", "03:12:00"), poolWait("03:45:00", "03:12:10")])));
  assert.deepEqual(grown.map(fold => fold.id), whole);
  assert.equal(grown.at(-1)!.entries.length, 4, "the stop, two messages and one merged wait");
});

test("time stamps sit above visible lines only and measure from the visible line before", () => {
  const feed = chatFeed(state([
    owner("start", "04:00:00"), reply("Ok.", "04:00:30"),
    relay("chat-057a", "x", "04:20:00"), relay("chat-057a", "y", "05:00:00"),
    owner("back?", "05:01:00"),
  ]));
  assert.deepEqual(kinds(feed), ["user", "agent", "fold", "user"]);
  assert.deepEqual([...stampedItems(feed)], [feed[0]!.id, feed[3]!.id]);
});

test("the unread count counts replies and no fold, of waits or of job messages (c117)", () => {
  const messages = [owner("hi", "06:00:00"), reply("Hi.", "06:00:30"), poolWait("06:30:00", "06:05:00"), owner("there?", "06:10:00"), reply("Yes.", "06:10:30"), relay("chat-057a", "done", "06:11:00")];
  assert.equal(unreadCount(messages, at("06:01:00")), 1);
});
