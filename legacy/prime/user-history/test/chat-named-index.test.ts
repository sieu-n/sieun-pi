// d7 11-04: at 21:55:36Z on 11-03 a duty's withBoardLinks ran about 1 s on the chat's main thread, 424 ms of it in chatNamed, which read every
// catalog row's name (about 8,400 rows) for each possessive ref ("CI and RepoOps's p476") on each of its three passes over the board, and the
// event loop stalled 1.1 s while CI rose to 51 of 80 cores. A wait now reads each row's name once per catalog array.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitRefs, withBoardLinks, type NamedChat } from "../src/shared/todo-hold.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/** `rows` catalog rows whose `name` getter counts its reads, with "CI and RepoOps" and "VP of CI" among them. */
function counted(rows: number): { chats: NamedChat[]; reads: () => number } {
  let reads = 0;
  const row = (id: string, name: string): NamedChat => ({ id, get name() { reads += 1; return name; } });
  const chats = Array.from({ length: rows }, (_, at) => row(`chat-${at}`, `job ${at} staging walk (metal)`));
  chats.push(row("ci", "CI and RepoOps"), row("vp", "VP of CI (+release)"));
  return { chats, reads: () => reads };
}

test("withBoardLinks reads each catalog row's name a bounded number of times, however many possessive waits the board holds", async () => {
  const { chats, reads } = counted(2_000);
  const plan: PlanItem[] = Array.from({ length: 20 }, (_, at) => ({ id: `p${at + 1}`, text: `step ${at + 1}`, status: "blocked", children: [],
    waitFor: at % 2 ? `CI and RepoOps's p${400 + at}` : `VP of CI's t${at}` }) as PlanItem);
  const board = { v: 2, rev: 1, updatedAt: "2026-11-03T21:55:00Z", plan, todos: [] } as unknown as ChatBoard;
  await withBoardLinks(board, "self", async () => null, chats);
  assert.ok(reads() <= 2 * chats.length, `read ${reads()} names for ${chats.length} rows`);
});

test("a possessive wait still resolves the longest whole-word name, its short form, and no chat when two share it or a row is archived", () => {
  const chats: NamedChat[] = [{ id: "ci", name: "CI and RepoOps" }, { id: "vp", name: "VP of CI (+release)" }, { id: "a", name: "ops guy" },
    { id: "b", name: "ops guy" }, { id: "old", name: "dusk", archived: true }, { id: "of", name: "of CI" }];
  const chat = (text: string) => waitRefs(text, chats).refs.map(ref => ref.chat);
  assert.deepEqual(chat("the next release in CI and RepoOps's p476"), ["ci"]);
  assert.deepEqual(chat("VP of CI's t3"), ["vp"]);
  assert.deepEqual(chat("then of CI's t3"), ["of"]);
  assert.deepEqual(chat("ops guy's p2"), [null]);
  assert.deepEqual(chat("dusk's p2"), [null]);
  assert.deepEqual(chat("xci and repoops's p2"), [null]);
});
