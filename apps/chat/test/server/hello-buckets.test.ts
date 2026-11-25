/**
 * A reconnecting page names what it holds of the hello's lists, and the hello carries only the buckets that changed (shared/hello-buckets.ts),
 * which the page merges into the same lists a whole hello holds. The page reads its open panels over the socket at the open (`read`).
 */
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import WebSocket from "ws";
import { HeldList } from "../../web/src/lib/api/hello-keep.ts";
import { digests, mergeBuckets, untimed } from "../../web/src/lib/api/shared/hello-buckets.ts";
import type { LiveEvent } from "../../web/src/lib/api/types.ts";
import { HELLO_PART_CHARS } from "../../server/app.ts";
import { start, type Running } from "./helpers.ts";

type Hello = Extract<LiveEvent, { type: "hello" }>;

let chat: Running | undefined;
after(() => chat?.close());

/** Opens a socket with `query` and returns its hello and a function that reads a route over it. */
async function open(base: string, query = ""): Promise<{ hello: Hello; bytes: number; read(path: string): Promise<Extract<LiveEvent, { type: "answer" }>>; close(): void }> {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/live${query}`);
  const answers = new Map<number, (event: Extract<LiveEvent, { type: "answer" }>) => void>();
  let id = 0;
  const hello = await new Promise<{ hello: Hello; bytes: number }>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", data => {
      const text = String(data);
      const event = JSON.parse(text) as LiveEvent;
      if (event.type === "hello") resolve({ hello: event, bytes: text.length });
      if (event.type === "answer") answers.get(event.id)?.(event);
    });
  });
  return {
    ...hello,
    read: path => new Promise(resolve => {
      answers.set(++id, resolve);
      socket.send(JSON.stringify({ type: "read", id, path }));
    }),
    close: () => socket.close(),
  };
}

const byId = <T extends { id: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

test("a page that names what it holds gets only the changed buckets, and merging them gives the whole hello's lists", async () => {
  chat = await start();
  const first = await open(chat.base);
  assert.equal(first.hello.partial, undefined);
  assert.ok(first.hello.conversations.length > 0 && first.hello.jobs.length > 0);
  const held = `?jobs=${digests(first.hello.jobs)}&conversations=${digests(first.hello.conversations)}`;
  // The lists as a page shows them: each thread's time put back.
  const lists = (hello: Hello, jobs = hello.jobs, conversations = hello.conversations) =>
    ({ jobs: byId(untimed("jobs", jobs, hello.times)), conversations: byId(untimed("conversations", conversations, hello.times)) });

  const same = await open(chat.base, held);
  assert.deepEqual(same.hello.partial, { jobs: [], conversations: [] });
  assert.deepEqual([same.hello.jobs.length, same.hello.conversations.length], [0, 0]);
  assert.ok(same.bytes < first.bytes / 2, `${same.bytes} bytes against ${first.bytes}`);

  // A rename moves the job thread's time, which every job of it carries.
  const thread = first.hello.jobs.find(job => job.conversation !== 1)!.thread;
  const before = first.hello.times[thread]!;
  assert.equal((await chat.send("PATCH", `/api/c/${thread}`, { name: "hello buckets job thread" })).status, 200);
  await chat.app.threads.refresh();
  const room = await chat.send("POST", "/api/rooms", { kind: "channel", name: "hello-buckets", members: [] });
  assert.equal(room.status, 200);
  const changed = await open(chat.base, held);
  const whole = await open(chat.base);
  assert.ok(whole.hello.times[thread]! > before, "the thread's time moved");
  assert.ok(changed.hello.partial!.conversations!.length >= 1);
  const merged = lists(changed.hello, mergeBuckets(first.hello.jobs, changed.hello.partial!.jobs!, changed.hello.jobs),
    mergeBuckets(first.hello.conversations, changed.hello.partial!.conversations!, changed.hello.conversations));
  assert.deepEqual(merged, lists(whole.hello));
  assert.ok(merged.conversations.some(c => c.id === room.body.id));
  assert.ok(merged.jobs.filter(job => job.thread === thread).every(job => job.updatedAt === whole.hello.times[thread]));

  // A string that is not a set of digests gets the whole list.
  const broken = await open(chat.base, "?jobs=zz");
  assert.equal(broken.hello.partial, undefined);
  assert.equal(broken.hello.jobs.length, whole.hello.jobs.length);
  for (const socket of [first, same, changed, whole, broken]) socket.close();
});

test("a hello reuses the last hello's timed lists and digests while the lists hold the same items", async t => {
  // After the 10:02Z start on 11-24 every page opened its socket again and each hello held the loop 130 to 150 ms, digests the top function.
  chat ??= await start();
  const first = await open(chat.base);
  const held = `?jobs=${digests(first.hello.jobs)}&conversations=${digests(first.hello.conversations)}`;
  first.close();
  const stringify = JSON.stringify;
  let calls = 0;
  t.mock.method(JSON, "stringify", function (this: unknown, ...args: Parameters<typeof JSON.stringify>) {
    calls += 1;
    return stringify.apply(this, args);
  });
  const counted = async (): Promise<{ calls: number; hello: Hello }> => {
    calls = 0;
    const page = await open(chat!.base, held);
    page.close();
    return { calls, hello: page.hello };
  };
  assert.equal((await chat.send("POST", "/api/rooms", { kind: "channel", name: "hello-reuse", members: [] })).status, 200);
  const built = await counted();
  const reused = await counted();
  t.mock.restoreAll();
  const items = first.hello.jobs.length + first.hello.conversations.length;
  assert.deepEqual(reused.hello.partial, built.hello.partial);
  assert.deepEqual([reused.hello.jobs, reused.hello.conversations, reused.hello.times], [built.hello.jobs, built.hello.conversations, built.hello.times]);
  assert.ok(built.calls - reused.calls >= items / 2, `the second hello stringified ${reused.calls} values and the first ${built.calls}, for ${items} items`);
});

test("a held list redigests only the buckets a partial hello changed, and its digests equal the whole hello's", async () => {
  chat ??= await start();
  const first = await open(chat.base);
  const jobs = new HeldList(first.hello.jobs);
  const conversations = new HeldList(first.hello.conversations);
  assert.equal(jobs.held(), digests(first.hello.jobs));
  assert.equal(conversations.held(), digests(first.hello.conversations));
  const held = `?jobs=${jobs.held()}&conversations=${conversations.held()}`;
  assert.equal((await chat.send("POST", "/api/rooms", { kind: "channel", name: "hello-held-list", members: [] })).status, 200);
  const changed = await open(chat.base, held);
  const whole = await open(chat.base);
  const partial = changed.hello.partial!;
  assert.ok(partial.conversations!.length >= 1 && partial.conversations!.length < 256);
  const nextJobs = jobs.next(mergeBuckets(jobs.items, partial.jobs!, changed.hello.jobs), partial.jobs!);
  const nextConversations = conversations.next(mergeBuckets(conversations.items, partial.conversations!, changed.hello.conversations), partial.conversations!);
  assert.equal(nextJobs.held(), digests(whole.hello.jobs));
  assert.equal(nextConversations.held(), digests(whole.hello.conversations));
  for (const socket of [first, changed, whole]) socket.close();
});

/** Opens a socket and returns every message up to the hello's last `list_part`, as the page gets them. */
async function helloFrames(base: string): Promise<string[]> {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/live`);
  const frames: string[] = [];
  await new Promise<void>((resolve, reject) => {
    let left = -1;
    socket.on("error", reject);
    socket.on("message", data => {
      const text = String(data);
      const event = JSON.parse(text) as LiveEvent;
      if (event.type === "hello") left = event.parts ?? 0;
      else if (event.type === "list_part") left -= 1;
      else return;
      frames.push(text);
      if (left === 0) resolve();
    });
  });
  socket.close();
  return frames;
}

test("a big hello goes in parts that each fit the budget, and joining them gives the whole hello's lists", async () => {
  // A browser builds each socket message's string in one task: the 2.5 MB cold hello of 11-25 held the page 528 to 697 ms at CPU rate 1.
  chat ??= await start();
  const [whole, ...none] = await helloFrames(chat.base);
  assert.deepEqual(none, []);
  const hello = JSON.parse(whole!) as Hello;
  assert.equal(hello.parts, undefined);
  const items = [...hello.jobs, ...hello.conversations].map(item => JSON.stringify(item).length);
  const budget = Math.max(...items) * 3;
  chat.app.helloPartChars = budget;
  try {
    const frames = await helloFrames(chat.base);
    const [head, ...parts] = frames.map(frame => JSON.parse(frame) as LiveEvent);
    assert.equal(head!.type, "hello");
    const first = head as Hello;
    assert.ok(parts.length >= 2 && first.parts === parts.length, `${parts.length} parts for ${items.length} items`);
    assert.ok(parts.every(part => part.type === "list_part"));
    const lists = (event: LiveEvent): string => JSON.stringify(event.type === "hello" || event.type === "list_part" ? [event.jobs, event.conversations] : null);
    for (const event of [first, ...parts]) assert.ok(lists(event).length <= budget + 64, `${lists(event).length} characters of items against ${budget}`);
    const joined = (parts as Extract<LiveEvent, { type: "list_part" }>[]).reduce(
      (all, part) => ({ jobs: [...all.jobs, ...part.jobs], conversations: [...all.conversations, ...part.conversations] }),
      { jobs: first.jobs, conversations: first.conversations },
    );
    assert.deepEqual(joined, { jobs: hello.jobs, conversations: hello.conversations });
    const { jobs: _j, conversations: _c, parts: _p, ...rest } = first;
    const { jobs: _wj, conversations: _wc, ...wholeRest } = hello;
    assert.deepEqual(rest, wholeRest);
  } finally {
    chat.app.helloPartChars = HELLO_PART_CHARS;
  }
});

test("a page reads a GET route over its socket, and an unknown route answers 404", async () => {
  chat ??= await start();
  const socket = await open(chat.base);
  const sidebar = await socket.read("/api/sidebar");
  assert.equal(sidebar.status, 200);
  assert.deepEqual(sidebar.value, await chat.get("/api/sidebar"));
  const missing = await socket.read("/api/nothing-here");
  assert.equal(missing.status, 404);
  assert.match(missing.error ?? "", /No endpoint GET \/api\/nothing-here/);
  socket.close();
});
