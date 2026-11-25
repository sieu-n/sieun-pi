/**
 * read_post for agents (app.ts `readAsAgent`, later-agents.ts `read`) on the fixture server: a comm thread names a post as set_emoji does,
 * and reads it whole with its `<room>/<post>` id, author and time, then its thread; a bad or unknown id answers one sentence.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/read-post.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

describe("an agent's read_post on the fixture server", () => {
  let s: Running;
  let comm: string;
  const read = (message: string | undefined, thread = comm) =>
    s.send<{ room: string; post: string; text: string; error?: string }>("GET", `/api/threads/${encodeURIComponent(thread)}/post${message === undefined ? "" : `?message=${encodeURIComponent(message)}`}`);
  before(async () => {
    s = await start({ wordMs: 1 });
    comm = s.app.agents.record(agents.crawler)!.comm!.ch_cutover!;
  });
  after(async () => {
    await s.close();
  });

  test("a bare post id reads the post whole, then its thread in the lines a reminder shows", async () => {
    const posts = s.app.agentStore.postsOf("ch_cutover");
    const reply = posts.find(p => p.threadRoot && p.deletedAt === undefined)!;
    const answer = await read(reply.id);
    assert.equal(answer.status, 200, answer.body.error);
    assert.equal(answer.body.room, "ch_cutover");
    assert.equal(answer.body.post, reply.id);
    const [where, header, ...rest] = answer.body.text.split("\n");
    assert.match(where!, new RegExp(`^ch_cutover/${reply.id} in #pi-cutover, a reply in the thread of ${reply.threadRoot}, \\d{4}-\\d\\d-\\d\\d\\.$`));
    assert.match(header!, new RegExp(`^\\[post ${reply.seq} \\(${reply.id}\\) from .+, at \\d\\d:\\d\\d:\\d\\dZ\\]$`), "the header a held call uses (moved.ts postHeader)");
    assert.ok(rest.join("\n").includes(reply.text), "the post's whole text follows its header");
    const root = posts.find(p => p.id === reply.threadRoot)!;
    assert.match(answer.body.text, /\n\nThe rest of its thread, \d+ repl(y|ies) in all:\n/);
    assert.match(answer.body.text, new RegExp(`^\\[post ${root.seq} \\(${root.id}\\) from `, "m"), "the thread shows its root under the same header");
    assert.equal(answer.body.text.split(`(${reply.id}) from`).length, 2, "the named post shows once");
  });

  test("a room-qualified id names the same post", async () => {
    const reply = s.app.agentStore.postsOf("ch_cutover").find(p => p.threadRoot && p.deletedAt === undefined)!;
    assert.equal((await read(`ch_cutover/${reply.id}`)).body.text, (await read(reply.id)).body.text);
  });

  test("an unknown post, a missing id and a thread that is no agent's answer one sentence each", async () => {
    for (const [answer, status] of [[await read("p9999"), 404], [await read(undefined), 400], [await read("p1", "no-such-thread"), 404]] as const) {
      assert.equal(answer.status, status, JSON.stringify(answer.body));
      assert.match(answer.body.error!, /^[^\n]+\.$/);
    }
  });
});
