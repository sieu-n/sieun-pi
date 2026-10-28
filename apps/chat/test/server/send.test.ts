/**
 * Sends land in the chat server first, as in Slack: the HTTP answer never waits on pi-host, a send pi-host cannot take yet is retried
 * from the outbox (also after a restart), and a channel post answers before its mentions reach their agents.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/send.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, LiveEvent, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const owned = (page: TimelinePage, text: string): Message[] =>
  page.items.filter((i): i is Message => i.kind === "message" && !i.id.startsWith("r:") && i.author.id === "owner" && i.text === text);
const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = performance.now();
  const value = await run();
  return { value, ms: performance.now() - t0 };
};

let s: Running;
let host: FixtureHost;
before(async () => {
  s = await start({ wordMs: 2 });
  host = s.host as FixtureHost;
});
after(async () => {
  await s.close();
});

describe("thread sends", () => {
  test("a send answers at once while pi-host hangs, and shows in the next page until it lands", async () => {
    const text = `hang ${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    host.beforeSubmit = async (_thread, input) => {
      if (input.text === text) await gate;
    };
    const live = await s.live();
    live.watch(ids.frontend);
    await live.waitFor(e => e.type === "status" && e.conversation === ids.frontend);
    const { value: sent, ms } = await timed(() => s.send("POST", `/api/c/${ids.frontend}/send`, { text, requestId: "hang-1" }));
    assert.equal(sent.status, 200);
    assert.ok(ms < 1000, `send took ${ms} ms`);
    assert.equal(sent.body.item.id, "r:hang-1");
    assert.equal(sent.body.item.send, "sending");
    await live.waitFor(e => e.type === "items" && e.items.some(i => i.id === "r:hang-1"));
    const page = await s.get<TimelinePage>(`/api/c/${ids.frontend}/items`);
    const pending = page.items.at(-1) as Message;
    assert.equal(pending.id, "r:hang-1");
    assert.equal(pending.text, text);
    assert.equal(pending.send, "sending");
    release();
    const landed = await until(() => s.get<TimelinePage>(`/api/c/${ids.frontend}/items`), p => owned(p, text).length > 0 && !p.items.some(i => i.id.startsWith("r:")));
    assert.equal(owned(landed, text).length, 1);
    await live.waitFor(e => e.type === "items" && !!e.removed?.includes("r:hang-1"));
    host.beforeSubmit = undefined;
    live.close();
  });

  test("a send pi-host refuses for a while is retried and lands once", async () => {
    const text = `retry ${Date.now()}`;
    let calls = 0;
    host.beforeSubmit = (_thread, input) => {
      if (input.text === text && ++calls <= 2) throw new Error("connect ECONNREFUSED /run/pi-host/host.sock");
    };
    const sent = await s.send("POST", `/api/c/${ids.crawler}/send`, { text, requestId: "retry-1" });
    assert.equal(sent.status, 200);
    const landed = await until(() => s.get<TimelinePage>(`/api/c/${ids.crawler}/items`), p => owned(p, text).length > 0, 15_000);
    assert.equal(owned(landed, text).length, 1);
    assert.equal(calls, 3);
    const again = await s.send("POST", `/api/c/${ids.crawler}/send`, { text, requestId: "retry-1" });
    assert.equal(again.status, 200);
    const page = await until(() => s.get<TimelinePage>(`/api/c/${ids.crawler}/items`), p => !p.items.some(i => i.id.startsWith("r:")));
    assert.equal(owned(page, text).length, 1, "a repeated requestId lands once");
    host.beforeSubmit = undefined;
  });

  test("a send pi-host refuses for good reads failed, and Retry and Discard act on it", async () => {
    const text = `refused ${Date.now()}`;
    let refuse = true;
    host.beforeSubmit = (_thread, input) => {
      if (input.text?.startsWith(text) && refuse) throw new Error("The thread is archived.");
    };
    const live = await s.live();
    live.watch(ids.frontend);
    await s.send("POST", `/api/c/${ids.frontend}/send`, { text, requestId: "refused-1" });
    await s.send("POST", `/api/c/${ids.frontend}/send`, { text: `${text} two`, requestId: "refused-2" });
    const failed = await until(() => s.get<TimelinePage>(`/api/c/${ids.frontend}/items`), p => p.items.filter(i => i.kind === "message" && i.send === "failed").length === 2);
    const row = failed.items.find(i => i.id === "r:refused-1") as Message;
    assert.match(row.sendError ?? "", /archived/);
    const discarded = await s.send("DELETE", `/api/c/${ids.frontend}/send/refused-2`);
    assert.equal(discarded.status, 200);
    await live.waitFor(e => e.type === "items" && !!e.removed?.includes("r:refused-2"));
    refuse = false;
    const retried = await s.send("POST", `/api/c/${ids.frontend}/send/refused-1/retry`);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.item.send, "sending");
    const landed = await until(() => s.get<TimelinePage>(`/api/c/${ids.frontend}/items`), p => owned(p, text).length === 1 && !p.items.some(i => i.id.startsWith("r:")));
    assert.equal(owned(landed, `${text} two`).length, 0);
    assert.equal((await s.send("POST", `/api/c/${ids.frontend}/send/refused-2/retry`)).status, 404);
    host.beforeSubmit = undefined;
    live.close();
  });

  test("a send to an unknown thread is 404", async () => {
    const sent = await s.send("POST", "/api/c/no-such-thread/send", { text: "hello", requestId: "nowhere-1" });
    assert.equal(sent.status, 404);
  });

  test("a live turn sends no partial text and no item per tool call", async () => {
    const agent = (await s.send("POST", "/api/agents", { name: "no stream" })).body as { id: string };
    const live = await s.live();
    live.watch(agent.id);
    await live.waitFor(e => e.type === "status" && e.conversation === agent.id);
    const text = `spawn a job ${Date.now()}`;
    await s.send("POST", `/api/c/${agent.id}/send`, { text, requestId: "nostream-1" });
    await live.waitFor(e => e.type === "items" && e.items.some(i => i.kind === "turn" && !i.live && i.text.includes(text)));
    const mine = live.events.filter((e): e is Extract<LiveEvent, { type: "items" }> => e.type === "items" && e.conversation === agent.id);
    assert.ok(!live.events.some(e => e.type === "partial" && !!e.partial), "no partial text");
    // The input, the run's start, the one answer with text before the job, each of its two send_message calls, and the run's end.
    assert.ok(mine.filter(e => e.items.some(i => i.kind === "turn")).length <= 6, `${mine.length} item events`);
    live.close();
  });
});

describe("restarts", () => {
  test("a send pi-host never took survives a restart and is delivered after it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-restart-"));
    const text = `restart ${Date.now()}`;
    try {
      const first = await start({ wordMs: 0, dataDir });
      (first.host as FixtureHost).beforeSubmit = () => {
        throw new Error("pi-host did not answer durable_submit in 120 s");
      };
      const sent = await first.send("POST", `/api/c/${ids.vent}/send`, { text, requestId: "restart-1" });
      assert.equal(sent.status, 200);
      await first.close();
      assert.ok(existsSync(join(dataDir, "outbox.jsonl")));
      assert.match(readFileSync(join(dataDir, "outbox.jsonl"), "utf8"), /restart-1/);

      const second = await start({ wordMs: 0, dataDir });
      try {
        const landed = await until(() => second.get<TimelinePage>(`/api/c/${ids.vent}/items`), p => owned(p, text).length > 0 && !p.items.some(i => i.id === "r:restart-1"), 15_000);
        assert.equal(owned(landed, text).length, 1);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("channel posts", () => {
  test("a post answers before its mentions reach their agents", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    host.beforeSubmit = async (_thread, input) => {
      if (input.requestId?.startsWith(`channel:${ids.cutoverChannel}:`)) await gate;
    };
    const { value: sent, ms } = await timed(() => s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "@frontend bro quick check", mentions: [ids.frontend], requestId: "post-fast-1" }));
    assert.equal(sent.status, 200);
    assert.ok(ms < 1000, `post took ${ms} ms`);
    assert.match(sent.body.item.id, /^p\d+$/);
    assert.equal(sent.body.item.requestId, "post-fast-1");
    assert.equal(sent.body.deliveries[0].state, "queued");
    release();
    const thread = await until(() => s.get(`/api/c/${ids.cutoverChannel}/replies/${sent.body.item.id}`), t => t.root.deliveries[0].state === "answered");
    assert.equal(thread.items[0].author.id, ids.frontend);
    host.beforeSubmit = undefined;
  });
});
