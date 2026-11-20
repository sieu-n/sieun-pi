/**
 * `scripts/duties/owner-style.ts`:
 * 1. STYLE_WORDS finds the owner's real style corrections of 11-20 and skips his feature asks of the same day.
 * 2. Candidates come only from owner posts of real rooms in the window, never from a test or archived room or an agent's post.
 * 3. A note counts as shared when the skill holds its skill words or the role text holds its role words.
 * 4. The role text is the one pi-host renders, so the p97 options rule shows in it.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ownerPosts, roleText, shared, STYLE_WORDS, type Note } from "../../scripts/duties/owner-style.ts";

const dir = mkdtempSync(join(tmpdir(), "owner-style-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("STYLE_WORDS finds the owner's style corrections and skips his feature asks", () => {
  for (const text of [
    "Superhuman's \"remind me if no reply\" intereseting can you elaborate? 이런거 말할떄는 가장 흥미로운거 하나는 제대로 설명해야지^^",
    "이런거 답변할때 hierarchical bullet point, checkmark 등 feature를 활용해서 답변해.",
    "first message still feels like too much slop. what would be ideal shape",
    "no this is not Chat. this is Slack.",
    "- 체크도 남발하지 마 제발 the final outcome should ALWAYS act like a Slack thread",
  ]) assert.ok(STYLE_WORDS.test(text), text);
  for (const text of [
    "Later should not be a separate tab. \n\nit should be a row in the Messages view instead.",
    "in app browser kinda weird",
    "SOLO는 뭔데",
    "add a \"Bookmark\" (i.e. save) message feature, and some kind of keep unread(?) or remind me(?) feature? 잘 풀어내봐",
  ]) assert.ok(!STYLE_WORDS.test(text), text);
});

test("candidates are owner posts of real rooms in the window", () => {
  const data = join(dir, "chat");
  mkdirSync(join(data, "rooms"), { recursive: true });
  writeFileSync(join(data, "rooms.json"), JSON.stringify({ rooms: [{ id: "ch_real" }, { id: "ch_walk", test: true }, { id: "ch_old", archived: true }] }));
  const post = (id: string, author: string, at: number) => JSON.stringify({ t: "post", post: { id, author, at, text: "too much slop" } });
  writeFileSync(join(data, "rooms", "ch_real.jsonl"), [post("p1", "owner", 2_000), post("p2", "ag_vent", 2_000), post("p3", "owner", 500), "{bad", JSON.stringify({ t: "set", post: "p1" })].join("\n"));
  writeFileSync(join(data, "rooms", "ch_walk.jsonl"), post("p1", "owner", 2_000));
  writeFileSync(join(data, "rooms", "ch_old.jsonl"), post("p1", "owner", 2_000));
  assert.deepEqual(ownerPosts(data, 1_000).map(p => `${p.room}/${p.id}`), ["ch_real/p1"]);
});

test("a note is shared when the skill or the role text holds its words", () => {
  const note: Note = { id: "options", posts: [], at: "2026-11-20T06:43:00Z", words: "", rule: "", skill: ["most interesting one"], role: ["when you list options"] };
  assert.deepEqual(shared(note, "explain the most interesting one", "nothing"), { skill: true, role: false });
  assert.deepEqual(shared(note, "nothing", "When you list options, pick"), { skill: false, role: true });
  assert.deepEqual(shared({ ...note, skill: [], role: undefined }, "most interesting one", "when you list options"), { skill: false, role: false });
});

test("the role text is what pi-host renders, with the p97 options rule and the shared-text routing", async () => {
  const profile = resolve(fileURLToPath(import.meta.url), "../../../../../packages/pi-host/src/durable/agent-profile.ts");
  const text = await roleText(profile);
  assert.match(text, /When you list options[\s\S]*most interesting one/);
  assert.match(text, /A correction of how you wrote a post counts too/);
  assert.match(text, /yours to put into the sw-factory skill/);
});
