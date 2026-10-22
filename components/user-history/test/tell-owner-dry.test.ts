// Guards c18 (owner 10-22: "dry simple message.") where the chat reads it at call time. In c18 clean-room runs 1 and 2 the brief asked for one
// dry sentence of at most 25 words, while the tell_owner description still said "1 or 2 short casual sentences", "a question goes in the same
// message as its context" and "never for the rest of the same answer", and both chats packed a status answer into 32- and 38-word sentences.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { TELL_OWNER_DESCRIPTION } from "../src/chat-guard.ts";

test("tell_owner: the tool description asks for the same dry message as the brief, and no line asks to pack the rest of an answer in (c18)", () => {
  assert.match(TELL_OWNER_DESCRIPTION, /best as one dry, plain sentence and at most 2, each of at most 25 words with one fact or ask/);
  assert.match(TELL_OWNER_DESCRIPTION, /no lead-in sentence/);
  assert.match(TELL_OWNER_DESCRIPTION, /A question is its own call/);
  assert.match(TELL_OWNER_DESCRIPTION, /a status answer gives only the one thing that matters most and the ids of the steps that hold the rest/);
  const c18 = CHAT_BRIEF.find(line => line.includes("(c18)")) ?? "";
  assert.match(c18, /best as one dry, plain sentence and at most 2, each of at most 25 words with one fact or ask/);
  assert.match(c18, /A status answer gives only the one thing that matters most/);
  const pulls = [/1 or 2 short casual sentences/, /a question goes in the same message as its context/, /never for the rest of the same answer/,
    /one answer never spreads over several messages/, /plus the question if one is open/, /a short judgment, the concrete cause and the measured cost/];
  for (const text of [TELL_OWNER_DESCRIPTION, ...CHAT_BRIEF]) for (const pull of pulls) assert.doesNotMatch(text, pull);
});
