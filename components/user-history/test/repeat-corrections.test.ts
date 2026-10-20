// Owner 10-09: "if i correct you like this, this should NEVER happen the next day". repeat_corrections_7d (d10) counts only repeats he gave after the fix ran; on 10-18 it counted c103's 05:21Z follow-up, which the chat's 05:22Z refine covered with c103 itself.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownerSaid, repeatsBetween, type ChatHistory, type Correction, type Ledger } from "../src/chat-corrections.ts";
import { refineCommand } from "../src/correction-refine.ts";
import { fileChatHistory } from "../src/owner-history.ts";
import { chatHistories } from "../scripts/duties/harness-health.ts";
import { gzipSync } from "node:zlib";

const chat = { id: "01a1164b-4a2d-742d-b27a-82f086ed0200", name: "AI harness developer environment VP" };
const first = "지금 자꾸 Mac에서 껐다켰다 하는 새끼 누구고 왜 그렇게 하는거야";
const follow = "Aside쓰면 깜빡이지를 않아 커서를 안가져가거든";
const rule = "Jobs never open, focus, move or close visible app windows on the owner's MacBook Pro while he uses it.";
const c103: Correction = { id: "c103", at: "2026-10-18T05:20:25.957Z", chat, words: first, rule, enforcedBy: "brief", ref: "brief", status: "reopened",
  theme: ["screen", "window", "focu", "mac"], repeats: [{ at: "2026-10-18T05:21:13.069Z", chat, words: follow }] };
const ledger: Ledger = { corrections: [c103] };
const since = Date.parse("2026-10-12T00:00:00Z");
const until = Date.parse("2026-10-19T21:46:00Z");
const count = async (history: ChatHistory) => (await repeatsBetween(ledger, since, until, async () => history)).map(({ entry, repeat }) => `${entry.id} ${repeat.words}`);

test("a follow-up the turn's one refine covered with the first correction is not a repeat (c103, 10-18 05:22Z)", async () => {
  const refine = refineCommand([{ id: "c103", words: first, rule }, { id: "c103", words: follow, rule }]);
  assert.deepEqual(await count({ owner: [first, follow], refines: [refine] }), []);
});

test("a repeat after the refine on the first correction counts, and so does one with no refine on record", async () => {
  const refines = [refineCommand([{ id: "c103", words: first, rule }]), refineCommand([{ id: "c103", words: follow, rule }])];
  assert.deepEqual(await count({ owner: [first, follow], refines }), [`c103 ${follow}`]);
  assert.deepEqual(await count({ owner: [first, follow], refines: [] }), [`c103 ${follow}`]);
});

test("a repeat whose words the owner never wrote in the chat does not count", async () => {
  assert.deepEqual(await count({ owner: [first], refines: [] }), []);
});

test("fileChatHistory reads the owner's words and the service's /refine commands from a session file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "repeat-corrections-")), "chat.jsonl");
  const refine = refineCommand([{ id: "c103", words: first, rule }, { id: "c103", words: follow, rule }]);
  writeFileSync(file, [
    { type: "message", message: { role: "user", content: [{ type: "text", text: first }], timestamp: Date.parse("2026-10-18T05:16:29.987Z") } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "/refine --global not a command" }], timestamp: Date.parse("2026-10-18T05:20:14Z") } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: follow }], timestamp: Date.parse("2026-10-18T05:21:00.875Z") } },
    { type: "custom_message", customType: "session_slash_command", content: refine, display: false, timestamp: "2026-10-18T05:22:04.450Z" },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  const history = await fileChatHistory(file);
  assert.deepEqual(history, { owner: [first, follow], refines: [refine] });
  assert.deepEqual(await count(history), []);
  assert.deepEqual(await fileChatHistory(join(tmpdir(), "no-such-chat.jsonl")), { owner: [], refines: [] });
});

test("a chat with no session file on this box is read from the Mac, and a failed Mac read is reported (frontend bro, 10-19)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repeat-corrections-mac-"));
  const line = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
  writeFileSync(join(dir, "aaaa.jsonl"), line("box words") + "\n");
  const asked: string[] = [];
  const errors: string[] = [];
  const history = chatHistories(dir, async chat => {
    asked.push(chat);
    if (chat === "cccc") throw new Error("ssh mac: Connection timed out");
    return chat === "bbbb" ? gzipSync(line("is any other tabs ready for review?") + "\n") : Buffer.alloc(0);
  }, errors);
  assert.deepEqual(await history("aaaa"), { owner: ["box words"], refines: [] });
  assert.deepEqual(await history("bbbb"), { owner: ["is any other tabs ready for review?"], refines: [] });
  assert.deepEqual(await history("dddd"), { owner: [], refines: [] });
  assert.deepEqual(await history("cccc"), { owner: [], refines: [] });
  assert.deepEqual(asked, ["bbbb", "dddd", "cccc"]);
  assert.deepEqual(errors, ["cccc: ssh mac: Connection timed out"]);
});

test("a repeat the chat cut with an ellipsis counts when each piece is in one owner message (c118, frontend bro 10-19)", () => {
  const owner = ["and it's ugly as fuck. 일단 이거 좀 성의있게 styling 할수 없어? consistent with our actual apps. 니가 보기엔 이게 괜찮아? 이런거 때문에 니가 현실성을 못느껴서 ㅈㄴ 대충하는거 같잖아."];
  assert.equal(ownerSaid("and it's ugly as fuck. 일단 이거 좀 성의있게 styling 할수 없어? consistent with our actual apps. ... 이런거 때문에 니가 현실성을 못느껴서", owner), true);
  assert.equal(ownerSaid("consistent with our actual apps. ... use subagent aggressively", owner), false);
});
