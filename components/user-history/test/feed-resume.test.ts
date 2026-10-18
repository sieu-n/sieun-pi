// Guards the 10-18 Mac reads: a tab hidden for 30 s closed its socket, and each return and each restart reconnect pulled the sessions list
// and the thread again, 1.0 MB of JSON and 254 KB on the wire in the first 6 s, over a Mac link of 12 to 400 KB/s. A reconnect now names what
// the page holds and gets what changed.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { applySessionsDelta, parseHave, rowHash, SessionsDiff, sessionsHave } from "../src/shared/sessions-delta.ts";
import { formatCursor, messageKey } from "../src/shared/message-key.ts";
import { applyThreadEvent, threadStateFromSnapshot } from "../src/shared/thread-state.ts";
import type { SessionRow, SessionsDelta, SessionsEvent, ThreadEvent } from "../src/shared/types.ts";

const row = (id: string, at: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/", lastActivityAt: at, created: at, ...extra } as unknown as SessionRow);
const event = (sessions: SessionRow[]): SessionsEvent => ({ type: "sessions", sessions, tags: [], daemon: "up" });

test("a reconnecting page that names its rows gets only the rows that changed, and ends with the server's list", () => {
  const held = [row("a", "2026-10-18T10:00:03Z"), row("b", "2026-10-18T10:00:02Z", { name: "old" }), row("c", "2026-10-18T10:00:01Z")];
  const now = [row("d", "2026-10-18T10:00:05Z"), row("b", "2026-10-18T10:00:04Z", { name: "new" }), row("a", "2026-10-18T10:00:03Z")];
  // A row whose fields were set in another order hashes the same.
  assert.equal(rowHash({ cwd: "/", id: "a", created: held[0]!.created, lastActivityAt: held[0]!.lastActivityAt, name: "a" } as unknown as SessionRow), rowHash(held[0]!));
  const have = parseHave(sessionsHave(held)!)!;
  const diff = new SessionsDiff();
  diff.resume(have);
  const frame = diff.frame(event(now)) as SessionsDelta;
  assert.equal(frame.type, "sessions-delta");
  assert.deepEqual(frame.add.map(added => added.id), ["d", "b"]);
  assert.deepEqual(frame.remove, ["c"]);
  assert.deepEqual(applySessionsDelta(held, frame), now);
  // Later frames are deltas against what the page now holds.
  const later = diff.frame(event([row("a", "2026-10-18T10:00:06Z"), now[0]!, now[1]!])) as SessionsDelta;
  assert.deepEqual(later.add, []);
  assert.deepEqual(later.patch.map(patch => patch.id), ["a"]);
  // A page with nothing changed still hears it is current.
  const same = new SessionsDiff();
  same.resume(parseHave(sessionsHave(now)!)!);
  const quiet = same.frame(event(now)) as SessionsDelta;
  assert.deepEqual([quiet.add, quiet.remove], [[], []]);
  // No `have`, or a malformed one, gets the whole list.
  assert.equal(new SessionsDiff().frame(event(now))?.type, "sessions");
  assert.equal(parseHave("nonsense"), null);
});

const ID = "01a1164b-0000-7000-8000-0000000000aa";
async function sessionFile(rounds: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feed-resume-"));
  const file = join(dir, ID + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T00:00:00.000Z", cwd: dir })];
  let parent: string | null = null;
  for (let index = 0; index < rounds; index++) {
    const id = index.toString(16).padStart(8, "0");
    const stamp = Date.parse("2026-10-18T00:00:00.000Z") + (index + 1) * 1000;
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(stamp).toISOString(), message: { role: "user", content: `message ${index} ` + "x".repeat(400), timestamp: stamp } }));
    parent = id;
  }
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

test("a reconnecting thread feed that names its newest message gets only the messages after it, and the board only when it changed", async () => {
  const file = await sessionFile(60);
  const board = { v: 2, rev: 7, updatedAt: "2026-10-18T10:00:00Z", plan: [], todos: [] };
  const catalog = { summary: async (id: string) => ({ sessionId: id, sessionFile: file, cwd: "/", lifecycle: "saved", messageCount: 60 }), hostOf: () => null } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), async () => board as never);
  const first: ThreadEvent[] = [];
  await hub.subscribe(ID, item => first.push(item));
  await new Promise(resolve => setTimeout(resolve, 50));
  const full = first.filter(item => item.type === "snapshot").at(-1);
  assert.ok(full?.type === "snapshot");
  const page = threadStateFromSnapshot(full.snapshot);
  const held = { ...page, messages: page.messages.slice(0, -3), board: board as never };
  const last = formatCursor({ kind: "message", key: messageKey(held.messages, held.messages.length - 1) });

  const again: ThreadEvent[] = [];
  await hub.subscribe(ID, item => again.push(item), false, { last, board: "7|2026-10-18T10:00:00Z" });
  const snapshots = again.filter(item => item.type === "snapshot");
  assert.equal(snapshots.length, 1, "no preview and no full page");
  const resumed = snapshots[0]!;
  assert.ok(resumed.type === "snapshot");
  assert.equal(resumed.snapshot.after, last);
  assert.equal(resumed.snapshot.messages.length, 3);
  assert.equal(again.some(item => item.type === "board"), false, "the board did not change");
  const after = applyThreadEvent(held, resumed);
  assert.deepEqual(after.messages.map(message => message.timestamp), page.messages.map(message => message.timestamp));
  assert.equal(after.older, held.older);

  // A page whose newest message the server does not hold gets the whole page, and a changed board comes again.
  const stale: ThreadEvent[] = [];
  await hub.subscribe(ID, item => stale.push(item), false, { last: "m1.0", board: "6|old" });
  assert.ok(stale.some(item => item.type === "snapshot" && item.snapshot.after === undefined && item.snapshot.messages.length === page.messages.length));
  assert.ok(stale.some(item => item.type === "board"));
  await hub.close();
});
