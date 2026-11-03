import assert from "node:assert/strict";
import { test } from "node:test";
import { EMOJI, emojiName, emojiOf, searchEmoji } from "../../web/src/lib/api/shared/emoji.ts";

test("a Slack name, a :name: or the emoji itself names one emoji", () => {
  assert.equal(emojiOf("eyes")?.char, "👀");
  assert.equal(emojiOf(":+1:")?.char, "👍");
  assert.equal(emojiOf("❤")?.char, "❤️", "an emoji without its variation selector still resolves");
  assert.equal(emojiName("✅"), "white_check_mark");
  assert.equal(emojiOf("not_an_emoji"), undefined);
  assert.ok(EMOJI.length > 1800);
});

test("search ranks an exact name first and finds an emoji by its Unicode name, as Slack's picker does", () => {
  assert.equal(searchEmoji("eyes")[0]?.char, "👀");
  assert.deepEqual(searchEmoji("eye", 3).map(e => e.names[0]), ["eye", "eye-in-speech-bubble", "eyes"]);
  assert.ok(searchEmoji("party").some(e => e.char === "🎉"), "party finds 🎉 through its Unicode name, party popper");
  assert.equal(searchEmoji("thumbs up")[0]?.char, "👍");
  assert.deepEqual(searchEmoji("  "), []);
});
