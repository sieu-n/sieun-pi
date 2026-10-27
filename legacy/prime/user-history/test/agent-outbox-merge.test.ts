// Guards 10-19: targets that waited in the account pool filled their daemon queue to 20 of 20, and the agent outbox then sent the messages it
// held one per freed pending slot, 1453 min of wait that day; ops guy's lane held 17 messages behind one refused head for 32 min. A lane's
// head now takes the queued messages behind it into its one send.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox, bundleText, DAEMON_MESSAGE_LIMIT, type Stop } from "../src/agent-outbox.ts";
import { QUEUED_PREFIX } from "../src/send-once.ts";

const CRAWLER = "01a115e2-4b8e-7d2c-9f31-6a0c2e5d8b17";
const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const FULL = "Target session has too many pending messages: 20 unfinished, limit is 20";
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message"';
const HEADER = /^\[(\d+) messages the chat service's outbox held for this session go together in this one send, oldest first\]/;

const until = async (done: () => boolean | Promise<boolean>) => { for (let i = 0; i < 2_000 && !await done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

interface Entry { id: string; text: string; state: string; error?: string; bundle?: { id: string }[] }

async function setup(t: TestContext, daemon: { unfinished: number; refuse?: ((text: string) => Error | undefined) | undefined; queued?: string[]; file?: string | null },
  stopped?: Stop) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-merge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const box = join(dir, "agent-outbox");
  const sent: string[] = [];
  const tries: string[] = [];
  const lines: string[] = [];
  const outbox = new AgentOutbox(box, {
    log: line => { lines.push(line); }, sleep: () => new Promise(resolve => setTimeout(resolve, 2)),
    send: async (_session, text) => {
      tries.push(text);
      const refusal = daemon.refuse?.(text);
      if (refusal) throw refusal;
      if (daemon.unfinished >= 20) throw new Error(FULL);
      sent.push(text);
      return "sent";
    },
    target: async () => ({ queued: daemon.queued ?? [], busy: true, unfinished: daemon.unfinished }),
    fileOf: async () => daemon.file ?? null,
    ...stopped ? { stopped: async () => stopped } : {},
  });
  t.after(() => outbox.close());
  const entries = async () => (await Promise.all((await readdir(box)).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(join(box, name), "utf8")) as Entry & { at: number }))).sort((a, b) => a.at - b.at);
  return { dir, sent, tries, lines, outbox, entries };
}

const order = (text: string, words: string[]) => words.map(word => text.indexOf(word)).every((at, index, all) => at >= 0 && (index === 0 || at > all[index - 1]!));

test("a target full at 20 of 20 with 5 messages held gets one send that carries all 5 in order once get_state reads room", async t => {
  const daemon = { unfinished: 20 };
  const box = await setup(t, daemon);
  await box.outbox.deliver(CRAWLER, "[wake] Run 39278044665 (CI) finished: success.");
  await until(() => box.tries.length >= 1);
  for (const text of ["report two", "report three", "[wake] Run 39278044670 (CI) finished: failure.", "report five"]) await box.outbox.deliver(CRAWLER, text);
  daemon.unfinished = 19;
  await box.outbox.outbox.idle();
  assert.equal(box.sent.length, 1, "one send_message takes all five");
  assert.equal(HEADER.exec(box.sent[0]!)?.[1], "5");
  assert.ok(order(box.sent[0]!, ["Run 39278044665", "report two", "report three", "Run 39278044670", "report five"]));
  assert.match(box.sent[0]!, /\[1 of 5, queued \d\d:\d\dZ\]\n\n\[wake\] Run 39278044665/);
  const entries = await box.entries();
  assert.deepEqual(entries.map(entry => entry.state), ["delivered", "obsolete", "obsolete", "obsolete", "obsolete"]);
  const head = entries[0]!;
  assert.equal(head.bundle?.length, 5);
  assert.ok(entries.slice(1).every(entry => entry.error === `it went inside ${head.id} with 4 others`));
  assert.equal(box.lines.filter(line => / obsolete, not sent/.test(line)).length, 0, "no line books a carried message as dropped");
});

test("ops guy's head refused again and again takes the 3 messages queued behind it into one send with one header", async t => {
  let refusals = 0;
  const box = await setup(t, { unfinished: 0, refuse: () => refusals-- > 0 ? new Error("Session worker is starting") : undefined });
  refusals = 1_000;
  await box.outbox.deliver(OPS, "[alert-escalation] 3 rules have nobody working their fire");
  await until(() => box.tries.length >= 2);
  await box.outbox.deliver(OPS, "[alert-bridge-recovered] 43 firing");
  await until(() => box.tries.some(text => text.includes("43 firing")) && box.tries.length >= 4);
  await box.outbox.deliver(OPS, "[alert-bridge-recovered] 44 firing");
  await box.outbox.deliver(OPS, "[alert-bridge-recovered] 48 firing");
  await until(() => box.tries.some(text => text.includes("48 firing")));
  refusals = 0;
  await box.outbox.outbox.idle();
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0]!.match(/messages the chat service's outbox held/g)?.length, 1, "a bundle that grows is rendered again, never nested");
  assert.equal(HEADER.exec(box.sent[0]!)?.[1], "4");
  assert.ok(order(box.sent[0]!, ["[1 of 4", "alert-escalation", "[2 of 4", "43 firing", "[3 of 4", "44 firing", "[4 of 4", "48 firing"]));
  const [head, ...carried] = await box.entries();
  assert.equal(head!.state, "delivered");
  assert.deepEqual(head!.bundle?.map(part => part.id), [head!.id, ...carried.map(entry => entry.id)]);
  // Each note counts the bundle when that message joined it; the head's bundle on disk holds all four.
  assert.ok(carried.every(entry => entry.state === "obsolete" && /^it went inside (\S+) with \d+ others?$/.exec(entry.error ?? "")?.[1] === head!.id));
});

test("a message that does not fit under the daemon's limit stays queued and goes in the next send, in order", async t => {
  const daemon = { unfinished: 20 };
  const box = await setup(t, daemon);
  // Sized so that it fits with the one message behind it and not with the two before it.
  const at = Date.now();
  const sized = (length: number) => "[alert-escalation] " + "x".repeat(length);
  const big = sized(DAEMON_MESSAGE_LIMIT - 512 - bundleText([{ at, text: sized(0) }, { at, text: "fourth" }], at).length);
  assert.ok(bundleText([{ at, text: "first" }, { at, text: "second" }, { at, text: big }], at).length > DAEMON_MESSAGE_LIMIT - 512);
  await box.outbox.deliver(OPS, "first");
  await until(() => box.tries.length >= 1);
  for (const text of ["second", big, "fourth"]) await box.outbox.deliver(OPS, text);
  daemon.unfinished = 0;
  await box.outbox.outbox.idle();
  assert.equal(box.sent.length, 2);
  assert.ok(box.sent.every(text => text.length <= DAEMON_MESSAGE_LIMIT));
  assert.ok(order(box.sent[0]!, ["first", "second"]) && !box.sent[0]!.includes("xxxx"));
  assert.ok(order(box.sent[1]!, ["[1 of 2", big, "[2 of 2", "fourth"]));
  assert.deepEqual((await box.entries()).map(entry => entry.state), ["delivered", "obsolete", "delivered", "obsolete"]);
});

test("an archived target's wake and a replaced report behind the head are ended with their proof, not carried", async t => {
  const daemon = { unfinished: 20 };
  const box = await setup(t, daemon, { record: "archive", reason: "the owner archived the target chat", at: 1 });
  await box.outbox.deliver(CRAWLER, "owner relay: keep going");
  await until(() => box.tries.length >= 1);
  await box.outbox.deliver(CRAWLER, "[wake] It is 13:20Z, the time you set with board.wake (13:20Z).", undefined, "wake", 0);
  await box.outbox.deliver(CRAWLER, "[replaceable: check-in]\ncheck-in report 1");
  await box.outbox.deliver(CRAWLER, "a sibling's question");
  await box.outbox.deliver(CRAWLER, "[replaceable: check-in]\ncheck-in report 2");
  daemon.unfinished = 0;
  await box.outbox.outbox.idle();
  assert.equal(box.sent.length, 1);
  assert.equal(HEADER.exec(box.sent[0]!)?.[1], "3");
  assert.ok(order(box.sent[0]!, ["keep going", "a sibling's question", "check-in report 2"]));
  assert.ok(!box.sent[0]!.includes("[wake]") && !box.sent[0]!.includes("check-in report 1"));
  const [, wake, report] = await box.entries();
  assert.equal(wake!.error, "the owner archived the target chat, and it is a wake");
  assert.match(report!.error ?? "", /^the newer report m-\S+ with the replaceable key "check-in" waits behind it$/);
});

test("a copy of a carried message sent again while its head waits finds the head and adds no entry", async t => {
  const daemon = { unfinished: 21, refuse: undefined as ((text: string) => Error | undefined) | undefined };
  const box = await setup(t, daemon);
  const from = { id: "01a11d24-ac9b-757d-ac51-9b2b7598782f", name: "ops guy" };
  const head = await box.outbox.queue({ session: CRAWLER, text: "first", from, role: "sibling", pending: 21, limit: 20 });
  const second = await box.outbox.queue({ session: CRAWLER, text: "second", from, role: "sibling", behind: true });
  // The target reads room, then refuses the bundle, as another sender filled it in between.
  daemon.refuse = text => { daemon.unfinished = 20; daemon.refuse = undefined; return text.includes("second") ? new Error(FULL) : undefined; };
  daemon.unfinished = 3;
  await until(() => box.tries.length >= 1);
  await until(async () => (await box.entries()).some(entry => entry.state === "obsolete"));
  const again = await box.outbox.queue({ session: CRAWLER, text: "second", from, role: "sibling", behind: true });
  assert.equal(again.id, head.id, "the resubmit names the head that carries it");
  assert.notEqual(second.id, head.id);
  assert.equal((await box.entries()).length, 2);
  daemon.unfinished = 0;
  await box.outbox.outbox.idle();
  assert.equal(box.sent.length, 1);
  assert.ok(order(box.sent[0]!, ["first", "second"]));
});

test("a bundle whose send timed out is found queued in the target's worker and not sent again", async t => {
  const daemon = { unfinished: 20, queued: [] as string[], refuse: undefined as ((text: string) => Error | undefined) | undefined };
  const box = await setup(t, daemon);
  await box.outbox.deliver(CRAWLER, "first");
  await until(() => box.tries.length >= 1);
  await box.outbox.deliver(CRAWLER, "second");
  await box.outbox.deliver(CRAWLER, "third");
  daemon.refuse = text => { daemon.queued = [QUEUED_PREFIX + text]; daemon.refuse = undefined; return new Error(TIMEOUT); };
  daemon.unfinished = 0;
  await box.outbox.outbox.idle();
  const bundles = box.tries.filter(text => HEADER.test(text));
  assert.equal(bundles.length, 1, "the bundle went once");
  assert.equal(box.sent.length, 0);
  assert.ok(order(bundles[0]!, ["first", "second", "third"]));
  assert.deepEqual((await box.entries()).map(entry => entry.state), ["delivered", "obsolete", "obsolete"]);
  assert.ok(box.lines.some(line => / is queued from the send at /.test(line)));
});
