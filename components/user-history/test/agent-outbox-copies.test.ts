// Guards two outbox gaps the 10-22 messaging audit found (wiki: sessions/2026/10/23/0132-harness-load-discussion). `keepOne` looked for a waiting
// copy and wrote the new entry two awaits apart, so from 10-19 to 10-22 15 groups of identical texts submitted within 1 s became 18 extra
// copies. A send held for a box that reads offline waited with no try and no log line, up to 10,292 s on 10-19.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";

const MAC_MANAGEMENT = "01a14d31-5b0e-7c1a-9d4f-2e8a6b0c3f71";
const FULL = "Target session has too many pending messages: 20 unfinished, limit is 20";

async function setup(t: TestContext, options: { host?: string; online?: () => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-copies-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const box = join(dir, "agent-outbox");
  const lines: string[] = [];
  const sent: string[] = [];
  let now = Date.parse("2026-10-20T06:27:02Z");
  const outbox = new AgentOutbox(box, {
    log: line => { lines.push(line); }, now: () => now, sleep: () => new Promise(resolve => setTimeout(resolve, 2)),
    send: async (_session, text) => { if (!options.online) throw new Error(FULL); sent.push(text); return "sent"; },
    target: async () => ({ queued: [], busy: true, unfinished: 20 }),
    fileOf: async () => null,
    ...options.host ? { hostOf: () => options.host!, reach: async () => ({ online: options.online!() }) as never } : {},
  });
  t.after(() => outbox.close());
  const entries = async () => Promise.all((await readdir(box)).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(join(box, name), "utf8")) as { id: string; text: string; state: string }));
  return { lines, sent, outbox, entries, tick: (ms: number) => { now += ms; } };
}

const until = async (done: () => boolean) => { for (let i = 0; i < 2_000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

test("two identical sends in the same tick keep one entry, as 06:27:02Z on 10-20 should have for mac-management", async t => {
  const box = await setup(t);
  const text = "[cross-host message from metal box owner] the disk alert cleared";
  await Promise.all([box.outbox.deliver(MAC_MANAGEMENT, text), box.outbox.deliver(MAC_MANAGEMENT, text), box.outbox.deliver(MAC_MANAGEMENT, text)]);
  const kept = (await box.entries()).filter(entry => entry.text === text);
  assert.equal(kept.length, 1, `one entry holds the text, not ${kept.length}`);
});

test("a send held for an offline box logs one line when its hold begins and one when it ends, with the wait", async t => {
  let online = false;
  const box = await setup(t, { host: "mac", online: () => online });
  await box.outbox.deliver(MAC_MANAGEMENT, "first report");
  await until(() => box.lines.some(line => line.includes("reads offline")));
  await new Promise(resolve => setTimeout(resolve, 30));
  const away = box.lines.filter(line => line.includes("reads offline"));
  assert.equal(away.length, 1, `one line for the hold, not one per look: ${JSON.stringify(away)}`);
  assert.match(away[0]!, /^outbox 01a14d31 on mac: m-\S+ waits with no try while mac reads offline$/);
  assert.equal(box.sent.length, 0);
  box.tick(10_292_000);
  online = true;
  await box.outbox.outbox.idle();
  const ended = box.lines.filter(line => line.includes("read offline; it goes now"));
  assert.equal(ended.length, 1);
  assert.match(ended[0]!, /^outbox 01a14d31 on mac: m-\S+ waited 10292 s while mac read offline; it goes now$/);
  assert.equal(box.sent.length, 1);
});
