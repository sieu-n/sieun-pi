// Guards the 10-18 Mac return: the Mac was offline from about 13:10Z to 19:42Z, and its return sent 221 held agent messages 1.7 h to 7.4 h
// after they were queued, 2 of them to 01a14b8d-c276, which the owner had archived at 07:22Z. A held message is dropped only on proof that it
// is needless, and every other one goes once, in order, with its age over it.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox, agedText, replaceableLine, stopRecords, unaged, wakeOf } from "../src/agent-outbox.ts";

const CHAT = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const ARCHIVED = "01a14b8d-c276-77a6-affe-302ad42b09d7";
const at = (iso: string) => Date.parse(`2026-10-18T${iso}Z`);
const runWake = (note: string) => `[wake] Run 39129768144 finished: failure (land.yml on sieun/dev). https://github.com/sieu-n/auto-sns-agent/actions/runs/39129768144 ` +
  `You set this wake with board.wake. Your note: ${note}`;
const timeWake = (now: string) => `[wake] It is 2026-10-18T${now}Z, the time you set with board.wake (2026-10-18T13:20:00.000Z).`;
const report = (text: string) => `[cross-host message from check-in VP of CI 01:10 (01a14fc7-c8be-773c-8656-3a8ca20a9d8d) on us-metal02; answer with ` +
  `agent_message.send(text, receiver_role="sibling", receiver_name="01a14fc7-c8be-773c-8656-3a8ca20a9d8d")]\n\n${replaceableLine("check-in report")}\n\n${text}`;
const landedLine = (text: string, when: number) => JSON.stringify({ type: "custom", customType: "agent_message", details: { message: text }, timestamp: new Date(when).toISOString() });

async function setup(t: TestContext, landed: Record<string, [string, number][]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-obsolete-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "archived-chats.json"), JSON.stringify({ ids: [ARCHIVED] }));
  await writeFile(join(dir, "deleted-jobs.json"), JSON.stringify({ [CHAT]: { "sub-94bc29bf": at("15:00:00") } }));
  const files = new Map<string, string>();
  for (const [session, lines] of Object.entries(landed)) {
    const file = join(dir, `${session}.jsonl`);
    await writeFile(file, lines.map(([text, when]) => landedLine(text, when)).join("\n") + "\n");
    files.set(session, file);
  }
  let now = at("13:13:00");
  const sent: { session: string; text: string; at: number }[] = [];
  const lines: string[] = [];
  const outbox = new AgentOutbox(join(dir, "agent-outbox"), {
    log: line => { lines.push(line); }, now: () => now, sleep: () => new Promise(resolve => setImmediate(resolve)),
    send: async (session, text) => { sent.push({ session, text, at: now }); return "sent"; },
    target: async () => ({ queued: [], busy: false, unfinished: 0 }),
    fileOf: async session => files.get(session) ?? null,
    stopped: stopRecords(dir),
    // Every target is on the Mac, which stays offline until `back` turns true.
    hostOf: () => "mac", reach: async () => ({ online: back }) as never,
  });
  t.after(() => outbox.close());
  let back = false;
  return {
    dir, sent, lines, outbox, files,
    at: (iso: string) => { now = at(iso); },
    /** Queues `text` for `session` at the time `when`. */
    queue: async (session: string, text: string, when: string) => { now = at(when); await outbox.deliver(session, text); },
    macBack: async (when: string) => { now = at(when); back = true; await outbox.outbox.idle(); },
    entries: async () => Promise.all((await readdir(join(dir, "agent-outbox"))).filter(name => name.endsWith(".json"))
      .map(async name => JSON.parse(await readFile(join(dir, "agent-outbox", name), "utf8")) as { text: string; state: string; error?: string })),
  };
}

test("a wake's identity is its run id or its set time", () => {
  assert.equal(wakeOf(runWake("a")), "run 39129768144");
  assert.equal(wakeOf(timeWake("13:20:26.473")), "time 2026-10-18T13:20:00.000Z");
  assert.equal(wakeOf("[cross-host message from VP of CI]\n\n[wake] Run 1 finished"), undefined);
});

test("an old message with no proof against it is delivered once, after 6.5 h, with its age over it", async t => {
  const box = await setup(t);
  const text = "[cross-host message from Crawler VP (01a115e2-9544-7204-b8db-000000000000) on us-metal02]\n\nLand 41 waits on red 3.";
  await box.queue(CHAT, text, "13:13:06");
  await box.macBack("19:42:22");
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0]!.text, `[queued 6.5 h ago at 13:13Z; the chat service's outbox held it until the target could take it]\n\n${text}`);
  assert.equal(unaged(box.sent[0]!.text), text);
});

test("a message that goes at once carries no age", async t => {
  const box = await setup(t);
  await box.macBack("13:00:00");
  await box.queue(CHAT, "on time", "13:00:00");
  await box.outbox.outbox.idle();
  assert.deepEqual(box.sent.map(item => item.text), ["on time"]);
  assert.equal(agedText("x", at("13:00:00"), at("13:00:29")), "x");
});

test("an older wake whose run or time already landed by another copy is kept as obsolete and not sent; a wake with no landed twin goes", async t => {
  const box = await setup(t, { [CHAT]: [[timeWake("13:20:26.473"), at("13:10:00")], [runWake("relayed copy"), at("14:02:00")]] });
  await box.queue(CHAT, runWake("LAND 39 PIN 4"), "13:51:15");
  // The landed time wake is older than this one was queued, so it proves nothing about it.
  await box.queue(CHAT, timeWake("13:20:27.001"), "13:20:27");
  await box.macBack("19:42:22");
  assert.deepEqual(box.sent.map(item => wakeOf(unaged(item.text))), ["time 2026-10-18T13:20:00.000Z"]);
  const kept = await box.entries();
  const dropped = kept.find(entry => entry.state === "obsolete");
  assert.match(dropped!.error!, /a wake for the same run 39129768144 landed in the target's file at 2026-10-18T14:02:00.000Z, after it was queued/);
  assert.equal(dropped!.text, runWake("LAND 39 PIN 4"), "the record keeps the message");
  assert.ok(box.lines.some(line => / obsolete, not sent: a wake for the same run 39129768144/.test(line)));
});

test("an old replaceable report is dropped only when a newer report with the same key waits behind it", async t => {
  const box = await setup(t);
  await box.queue(CHAT, report("staging is still land 38"), "15:58:33");
  await box.queue(CHAT, "VP instruction: land 40 after promote 13", "16:00:00");
  await box.queue(CHAT, report("land 39 pin 4 went red"), "16:14:38");
  const other = "01a11b0b-7c15-73da-9481-8de15903eab4";
  await box.queue(other, report("the only report for this chat"), "16:15:56");
  await box.macBack("19:43:00");
  const to = (session: string) => box.sent.filter(item => item.session === session).map(item => unaged(item.text).split("\n\n").at(-1));
  assert.deepEqual(to(CHAT), ["VP instruction: land 40 after promote 13", "land 39 pin 4 went red"]);
  assert.deepEqual(to(other), ["the only report for this chat"]);
  assert.ok(box.sent.every(item => item.text.startsWith("[queued ")));
  assert.ok(box.lines.some(line => /obsolete, not sent: the newer report m-\S+ with the replaceable key "check-in report" waits behind it/.test(line)));
});

test("the archived chat 01a14b8d-c276 of 10-18 still gets the 17:07Z Crawler VP message, and its stale 13:20Z time wake stays unsent", async t => {
  const box = await setup(t);
  const crawler = "[cross-host message from Crawler VP (01a115e2-9544-7204-b8db-000000000000) on us-metal02]\n\nCrawler status.";
  box.at("13:20:27");
  await box.outbox.deliver(ARCHIVED, timeWake("13:20:26.473"), undefined, "wake");
  await box.queue(ARCHIVED, crawler, "17:07:19");
  await box.macBack("19:43:22");
  assert.deepEqual(box.sent.map(item => unaged(item.text)), [crawler]);
  assert.ok(box.sent[0]!.text.startsWith("[queued 2.6 h ago at 17:07Z;"));
  const kept = await box.entries();
  assert.deepEqual(kept.map(entry => [entry.state, entry.error]).sort(), [["delivered", undefined], ["obsolete", "the owner archived the target chat, and it is a wake"]]);
});

test("a resend of a tried spawn brief to an archived chat stays unsent", async t => {
  const box = await setup(t);
  box.at("13:00:00");
  await box.outbox.deliver(ARCHIVED, "[brief] your brief again", undefined, "retry");
  await box.macBack("19:43:22");
  assert.deepEqual(box.sent, []);
});

test("a message of any kind to a job the cleanup deleted is not sent or relayed", async t => {
  const box = await setup(t);
  const job = "01a14fe6-0000-7000-8000-000000000000";
  box.files.set(job, join(box.dir, "session-artifacts", CHAT, "sub-94bc29bf", `${job}.jsonl`));
  await box.queue(job, "a VP's instruction", "17:35:00");
  await box.macBack("19:43:00");
  assert.deepEqual(box.sent, []);
  assert.match((await box.entries())[0]!.error!, /^the cleanup deleted the target job sub-94bc29bf at 2026-10-18T15:00:00.000Z$/);
});

test("the same text that already landed after it was queued is not sent again, while an earlier landing of it proves nothing", async t => {
  const alert = "[alert] A Grafana rule you own is firing: metal-backup-ch-redis-age. The bridge tells you again in 30 min.";
  const box = await setup(t, { [CHAT]: [[alert, at("12:52:37")]] });
  await box.queue(CHAT, alert, "13:22:58");
  await box.macBack("20:39:14");
  assert.equal(box.sent.length, 1, "the bridge's planned re-tell goes");
  const twin = await setup(t, { [CHAT]: [[alert, at("14:00:00")]] });
  await twin.queue(CHAT, alert, "13:22:58");
  await twin.macBack("20:39:14");
  assert.deepEqual(twin.sent, []);
});
