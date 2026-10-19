// Guards the 10-19 steady main thread: on a scratch serve at the live rate (13.3 roster updates a second) the catalog built every subagent's
// roster agent again on each update, 6.9 s of 68 s of main-thread time in 300 s, though an update replaces only the rows it changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { cutSources, rosterChildren } from "../src/chat-catalog.ts";
import { type Cut, SessionCuts } from "../src/cut-end.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const child = (id: string, name: string, extra: Partial<SessionSummary> = {}) => ({ sessionId: id, parentSessionId: CHAT, rlmChildId: `c-${id}`, runtimeKind: "subagent",
  sessionName: name, cwd: "/tmp", messageCount: 4, lastActivityAt: "2026-10-19T01:00:00.000Z", sessionFile: `/tmp/${id}.jsonl`, ...extra } as SessionSummary);

test("an unchanged roster row keeps its agent and cut source, and a changed row or cut gets new ones", () => {
  const cuts = new SessionCuts();
  const one = child("s1", "one");
  const two = child("s2", "two");
  const first = rosterChildren([one, two], cuts).get(CHAT)!;
  const again = rosterChildren([one, two], cuts).get(CHAT)!;
  assert.equal(again[0], first[0], "the same row object gives the same agent");
  assert.equal(again[1], first[1]);
  assert.equal(cutSources([one])[0], cutSources([one])[0], "the same row object gives the same cut source");

  const twoLater = child("s2", "two later", { lastActivityAt: "2026-10-19T01:05:00.000Z" });
  const changed = rosterChildren([one, twoLater], cuts).get(CHAT)!;
  assert.equal(changed[0], first[0]);
  assert.notEqual(changed[1], first[1]);
  assert.equal(changed[1]!.label, "two later");
  assert.equal(changed[1]!.lastActivityAt, Date.parse("2026-10-19T01:05:00.000Z"));

  const cut: Cut = { at: Date.parse("2026-10-19T01:06:00.000Z"), cause: "mid-tool" };
  const withCut = new SessionCuts();
  withCut.of = (file: string | undefined) => file === one.sessionFile ? cut : null;
  const cutNow = rosterChildren([one, twoLater], withCut).get(CHAT)!;
  assert.notEqual(cutNow[0], first[0], "a cut that came builds the agent again");
  assert.equal(cutNow[0]!.status, "error");
  assert.equal(cutNow[1], changed[1]);
});
