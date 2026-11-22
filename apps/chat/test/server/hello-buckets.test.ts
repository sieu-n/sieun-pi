/**
 * A reconnecting page names what it holds of the hello's lists, and the hello carries only the buckets that changed (shared/hello-buckets.ts),
 * which the page merges into the same lists a whole hello holds. The page reads its open panels over the socket at the open (`read`).
 */
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import WebSocket from "ws";
import { digests, mergeBuckets, untimed } from "../../web/src/lib/api/shared/hello-buckets.ts";
import type { LiveEvent } from "../../web/src/lib/api/types.ts";
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
