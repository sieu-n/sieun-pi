/**
 * A comm thread gets Prime's tell_owner text and chat brief without their rules on how a message reads, so the role text is the one place
 * for a post's shape (`room-post.ts`; owner p54 in dm_agent-factory, msg mwqt6ry1, and the 11-21 channel-thread capture).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CHAT_BRIEF } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { TELL_OWNER_DESCRIPTION, TELL_OWNER_PARAMETERS } from "../../../../legacy/prime/user-history/src/chat-guard.ts";
import { tellOwner } from "../../../../legacy/prime/user-history/src/chat-guard.ts";
import { LONG_REPLY_MARK } from "../../../../legacy/prime/user-history/src/shared/reply-lint.ts";
import { MODEL_POST } from "../../src/durable/agent-profile.ts";
import { COMM_BRIEF, ROOM_LONG, ROOM_TELL_OWNER_DESCRIPTION, ROOM_TELL_OWNER_PARAMETERS } from "../../src/durable/room-post.ts";

const SHAPE = /no bullets|Two points are two calls|Call it again for a second point|three todos are three messages|Put no colon|best as one dry, plain sentence/;

test("tell_owner in a room keeps Prime's rules for when to post and leaves how a post reads to the role text", () => {
  assert.match(TELL_OWNER_DESCRIPTION, SHAPE);
  assert.doesNotMatch(ROOM_TELL_OWNER_DESCRIPTION, SHAPE);
  assert.match(ROOM_TELL_OWNER_DESCRIPTION, /^Post one message to the owner in the room, as a coworker posts in Slack\. On a turn he started, answer him\./);
  assert.match(ROOM_TELL_OWNER_DESCRIPTION, /the default is no call[\s\S]*is kept as a note \(c117\)\. Use the plain words he would use[\s\S]*\(c145\)\. How a post reads[\s\S]*is in your role steps\.$/);
  assert.deepEqual(ROOM_TELL_OWNER_PARAMETERS.required, TELL_OWNER_PARAMETERS.required);
  assert.deepEqual(ROOM_TELL_OWNER_PARAMETERS.properties.why, TELL_OWNER_PARAMETERS.properties.why);
  assert.match(ROOM_TELL_OWNER_PARAMETERS.properties.reply_to.description, /lands in that post's thread[\s\S]*set it when you answer an older post/);
});

test("a comm thread's brief drops only the shape rules of the tell_owner line", () => {
  assert.equal(COMM_BRIEF.length, CHAT_BRIEF.length);
  const changed = COMM_BRIEF.flatMap((line, index) => line === CHAT_BRIEF[index] ? [] : [line]);
  assert.equal(changed.length, 1);
  assert.doesNotMatch(changed[0]!, SHAPE);
  assert.match(changed[0]!, /^Reach the owner only through tell_owner, on every kind of turn\. Other text shows only in the fold he opens\. How a post reads[\s\S]*is in your role steps\. On a turn the owner did not start[\s\S]*Message another thread only when it must act\.$/);
});

test("the post the owner called a model goes out on the first try in a room, and a longer one is held with the room's note (msg mwqtp2l1)", () => {
  const turn = { owner: true, ownerIds: new Set<string>() };
  const held = tellOwner({ text: MODEL_POST }, turn);
  assert.equal(held.kind, "refused", "a Prime chat's 80 words hold it");
  assert.match(held.kind === "refused" ? held.text : "", /^Not sent, it runs long, with 81 words in all\. Text him like a Slack DM/);
  assert.notEqual(tellOwner({ text: MODEL_POST }, { ...turn, long: ROOM_LONG }).kind, "refused");
  const longer = `${MODEL_POST}\n${"- one more point the post did not need to carry at all\n".repeat(4)}`;
  const note = tellOwner({ text: longer }, { ...turn, long: ROOM_LONG });
  assert.equal(note.kind, "refused");
  assert.ok(note.kind === "refused" && note.text.startsWith(LONG_REPLY_MARK));
  assert.match(note.kind === "refused" ? note.text : "", /words in all\. Keep the post within 120 words: the answer on its own line[\s\S]*\(c98\)\.$/);
  assert.doesNotMatch(note.kind === "refused" ? note.text : "", /one or two short sentences/);
});
