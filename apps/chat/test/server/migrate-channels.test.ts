import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { AgentStore, type GroupRoom } from "../../server/agent-store.ts";
import { migrateChannels } from "../../server/migrate-channels.ts";

const T0 = Date.UTC(2026, 9, 28, 0, 0);
const CH = "ch_0000aaaa";
const EMPTY = "ch_0000bbbb";
let dir: string;

function files(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}
function changed(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
}

const delivery = (target: string, state: string, extra: Record<string, unknown> = {}) => ({ target, name: target, state, at: T0 + 5, thread: target, conversation: 1, ...extra });
const post = (seq: number, author: string, extra: Record<string, unknown> = {}) => ({
  id: `p${seq}`, seq, channel: CH, author, text: `post ${seq}`, images: [], mentions: [], at: T0 + seq * 1000, hops: author === "owner" ? 0 : 1,
  requestId: `req-${seq}`, deliveries: [], ...extra,
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "apps-chat-migrate-channels-"));
  mkdirSync(join(dir, "channels"));
  mkdirSync(join(dir, "rooms"));
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    v: 1,
    agents: [
      { id: "ag_alpha", slug: "alpha", name: "alpha", room: "dm_alpha", workThread: "thread-alpha", host: "h", home: "/", createdAt: T0, archived: false },
      { id: "ag_beta", slug: "beta", name: "beta", room: "dm_beta", workThread: "thread-beta", host: "h", home: "/", createdAt: T0, archived: false },
    ],
    aliases: { "thread-alpha": "ag_alpha", "job-beta": "ag_beta" },
  }));
  writeFileSync(join(dir, "rooms.json"), JSON.stringify({
    v: 1, rooms: [{ id: "dm_alpha", kind: "dm", agent: "ag_alpha", createdAt: T0, archived: false }], feed: { ag_alpha: { entry: 4, open: {} } },
  }));
  writeFileSync(join(dir, "rooms", "dm_alpha.jsonl"), line({ t: "post", post: { id: "p1", seq: 1, room: "dm_alpha", author: "owner", text: "dm", images: [], at: T0, requestId: "dm-1" } }));
  writeFileSync(join(dir, "channels.json"), JSON.stringify({
    channels: [
      {
        id: CH, name: "build", purpose: "ship it", homeChat: "thread-alpha", createdAt: T0, archived: false,
        members: [
          { principal: "owner", role: "owner", wakeOn: "all", addedAt: T0 },
          { principal: "thread-alpha", role: "member", wakeOn: "mention", addedAt: T0 + 1 },
          { principal: "job-beta", role: "member", wakeOn: "all", addedAt: T0 + 2 },
          { principal: "ghost-thread", role: "member", wakeOn: "mention", addedAt: T0 + 3 },
        ],
      },
      { id: EMPTY, name: "quiet", purpose: "", createdAt: T0, archived: true, members: [{ principal: "owner", role: "owner", wakeOn: "all", addedAt: T0 }] },
    ],
  }));
  writeFileSync(join(dir, "channels", `${CH}.jsonl`), [
    line({ t: "post", post: post(1, "owner", { mentions: ["thread-alpha", "job-beta", "ghost-thread"] }) }),
    line({ t: "delivery", post: "p1", delivery: delivery("thread-alpha", "queued") }),
    line({ t: "delivery", post: "p1", delivery: delivery("thread-alpha", "answered", { submission: 7, answerPost: "p2" }) }),
    line({ t: "delivery", post: "p1", delivery: delivery("job-beta", "no_reply", { submission: 8 }) }),
    line({ t: "delivery", post: "p1", delivery: delivery("ghost-thread", "failed", { error: "no thread" }) }),
    line({ t: "post", post: post(2, "thread-alpha", { threadRoot: "p1", mentions: ["job-beta"], requestId: "answer:p1:thread-alpha" }) }),
    line({ t: "delivery", post: "p2", delivery: delivery("job-beta", "stopped", { error: "hops" }) }),
    line({ t: "post", post: post(3, "ghost-thread", { requestId: undefined }) }),
    line({ t: "post", post: post(4, "owner", { requestId: "req-1" }) }),
  ].join(""));
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("a dry run reports the rooms, member mapping and post counts, and writes nothing", () => {
  const was = files(dir);
  const report = migrateChannels(dir, { apply: false });
  assert.deepEqual(changed(was, files(dir)), []);
  const build = report.channels.find(m => m.room.id === CH)!;
  assert.equal(build.roomExisted, false);
  assert.equal(build.ownerDropped, true);
  assert.deepEqual(build.members.map(m => [m.from, m.agent, m.wakeOn, m.mapped]), [
    ["thread-alpha", "ag_alpha", "mention", true],
    ["job-beta", "ag_beta", "all", true],
    ["ghost-thread", "ghost-thread", "mention", false],
  ]);
  assert.equal(build.posts, 4);
  assert.deepEqual(build.append, ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(report.unmapped, ["ghost-thread"]);
  assert.equal(report.channels.find(m => m.room.id === EMPTY)!.posts, 0);
  assert.equal(report.postsWritten, 0);
  assert.equal(report.roomsWritten, 0);
});

test("apply writes channel rooms and posts mapped to agent ids, and leaves the old files and DM rooms alone", () => {
  const was = files(dir);
  const report = migrateChannels(dir, { apply: true });
  assert.equal(report.roomsWritten, 2);
  assert.equal(report.postsWritten, 4);
  assert.deepEqual(changed(was, files(dir)), ["rooms.json", `rooms/${CH}.jsonl`]);

  const store = new AgentStore(dir);
  assert.deepEqual(store.rooms.rooms.map(r => r.id), ["dm_alpha", CH, EMPTY]);
  assert.deepEqual(store.rooms.feed, { ag_alpha: { entry: 4, open: {} } });
  const room = store.rooms.rooms.find(r => r.id === CH) as GroupRoom;
  assert.deepEqual(room, {
    id: CH, kind: "channel", name: "build", purpose: "ship it", homeChat: "thread-alpha", createdAt: T0, archived: false,
    members: [
      { agent: "ag_alpha", wakeOn: "mention", addedAt: T0 + 1 },
      { agent: "ag_beta", wakeOn: "all", addedAt: T0 + 2 },
      { agent: "ghost-thread", wakeOn: "mention", addedAt: T0 + 3 },
    ],
  });
  assert.deepEqual(store.rooms.rooms.find(r => r.id === EMPTY), { id: EMPTY, kind: "channel", name: "quiet", purpose: "", createdAt: T0, archived: true, members: [] });

  const posts = store.postsOf(CH);
  assert.deepEqual(posts.map(p => [p.id, p.seq, p.author, p.at, p.hops]), [
    ["p1", 1, "owner", T0 + 1000, 0], ["p2", 2, "ag_alpha", T0 + 2000, 1], ["p3", 3, "ghost-thread", T0 + 3000, 1], ["p4", 4, "owner", T0 + 4000, 0],
  ]);
  const [p1, p2, p3, p4] = posts;
  assert.deepEqual(p1!.mentions, ["ag_alpha", "ag_beta", "ghost-thread"]);
  assert.deepEqual(p1!.deliveries!.map(d => [d.target, d.state, d.attempts, d.submission, d.error, d.requestId]), [
    ["ag_alpha", "delivered", 1, 7, undefined, `channel:${CH}:p1:thread-alpha`],
    ["ag_beta", "delivered", 1, 8, undefined, `channel:${CH}:p1:job-beta`],
    ["ghost-thread", "failed", 1, undefined, "no thread", `channel:${CH}:p1:ghost-thread`],
  ]);
  assert.equal(p2!.threadRoot, "p1");
  assert.deepEqual(p2!.mentions, ["ag_beta"]);
  assert.deepEqual(p2!.deliveries!.map(d => [d.target, d.state, d.attempts]), [["ag_beta", "stopped", 0]]);
  assert.equal(p2!.requestId, "answer:p1:thread-alpha");
  // A post with no requestId, and a post whose requestId an earlier post took, get a key of their own.
  assert.equal(p3!.requestId, `c:${CH}:p3`);
  assert.equal(p4!.requestId, `c:${CH}:p4`);
  assert.equal(store.postsOf("dm_alpha").length, 1);
});

test("a second run changes nothing", () => {
  const was = files(dir);
  const report = migrateChannels(dir, { apply: true });
  assert.deepEqual(changed(was, files(dir)), []);
  assert.equal(report.postsWritten, 0);
  assert.equal(report.roomsWritten, 0);
  const build = report.channels.find(m => m.room.id === CH)!;
  assert.equal(build.roomExisted, true);
  assert.equal(build.present, 4);
  assert.deepEqual(build.append, []);
});

test("a run after the old server wrote more posts appends only the posts the room lacks", () => {
  appendFileSync(join(dir, "channels", `${CH}.jsonl`), [
    line({ t: "post", post: post(5, "owner", { mentions: ["thread-alpha"] }) }),
    line({ t: "delivery", post: "p5", delivery: delivery("thread-alpha", "read", { submission: 9 }) }),
  ].join(""));
  const was = files(dir);
  const dry = migrateChannels(dir, { apply: false });
  assert.deepEqual(changed(was, files(dir)), []);
  assert.deepEqual(dry.channels.find(m => m.room.id === CH)!.append, ["p5"]);

  const report = migrateChannels(dir, { apply: true });
  assert.equal(report.postsWritten, 1);
  assert.deepEqual(changed(was, files(dir)), [`rooms/${CH}.jsonl`]);
  const posts = new AgentStore(dir).postsOf(CH);
  assert.deepEqual(posts.map(p => p.id), ["p1", "p2", "p3", "p4", "p5"]);
  assert.deepEqual(posts[4]!.deliveries!.map(d => [d.target, d.state, d.submission]), [["ag_alpha", "delivered", 9]]);
});

test("an old post that cannot keep its id is reported and not written", () => {
  appendFileSync(join(dir, "channels", `${CH}.jsonl`), line({ t: "post", post: post(7, "owner") }));
  const was = files(dir);
  const report = migrateChannels(dir, { apply: true });
  assert.deepEqual(changed(was, files(dir)), []);
  assert.deepEqual(report.channels.find(m => m.room.id === CH)!.blocked, [{ post: "p7", reason: "the room's next post is p6" }]);
});
