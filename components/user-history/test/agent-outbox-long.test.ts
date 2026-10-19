// Guards 10-19 15:46Z: the daemon refused a 17019-char alert escalation to ops guy (01a11af8) on every try ("Agent session message is too
// long: 17019 chars exceeds 16384"), and that one outbox entry held every later message to the chat. A long message goes in parts, in place.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox, DAEMON_MESSAGE_LIMIT, messageParts } from "../src/agent-outbox.ts";

const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const escalation = (rules: number) => "[alert-escalation] " + `${rules} rules have nobody working their fire 30 min after it:\n` +
  Array.from({ length: rules }, (_, index) => `engage-prod-rule-${index} (Engage fleet snapshot unavailable (production), firing since 15:${String(index % 60).padStart(2, "0")}Z)`).join("\n");
const body = (part: string) => part.replace(/^\[part \d+ of \d+; [^\]\n]*\]\n\n/, "");

async function setup(t: TestContext, onDisk: object[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-long-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const box = join(dir, "agent-outbox");
  await mkdir(box, { recursive: true });
  for (const entry of onDisk) await writeFile(join(box, `${(entry as { id: string }).id}.json`), JSON.stringify(entry));
  const sent: string[] = [];
  const outbox = new AgentOutbox(box, {
    log: () => {}, sleep: () => new Promise(resolve => setImmediate(resolve)),
    send: async (_session, text) => {
      if (text.length > DAEMON_MESSAGE_LIMIT) throw new Error(`Agent session message is too long: ${text.length} chars exceeds ${DAEMON_MESSAGE_LIMIT}`);
      sent.push(text);
      return "sent";
    },
    target: async () => ({ queued: [], busy: false, unfinished: 0 }),
    fileOf: async () => null,
  });
  t.after(() => outbox.close());
  const entries = async () => Promise.all((await readdir(box)).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(join(box, name), "utf8")) as { text: string; state: string; error?: string }));
  return { sent, outbox, entries };
}

test("a text that fits goes as it is, and a long one splits at line breaks into parts that each fit and join back to it", () => {
  assert.deepEqual(messageParts("short"), ["short"]);
  const text = escalation(260);
  assert.ok(text.length > DAEMON_MESSAGE_LIMIT);
  const parts = messageParts(text);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every(part => part.length <= DAEMON_MESSAGE_LIMIT - 200));
  assert.match(parts[1]!, /^\[part 2 of \d+; /);
  assert.equal(parts.map(body).join(""), text);
  assert.ok(parts.slice(0, -1).every(part => part.endsWith("\n")));
  const emoji = "\u{1F600}".repeat(DAEMON_MESSAGE_LIMIT);
  assert.equal(messageParts(emoji).map(body).join(""), emoji);
});

test("a long alert queued before two short messages goes in parts in its place, and the short ones follow", async t => {
  const box = await setup(t);
  const alert = escalation(260);
  await box.outbox.deliver(OPS, alert);
  await box.outbox.deliver(OPS, "[alert-bridge-recovered] 43 firing");
  await box.outbox.deliver(OPS, "[alert-bridge-recovered] 48 firing");
  await box.outbox.outbox.idle();
  const parts = box.sent.slice(0, -2);
  assert.equal(parts.map(body).join(""), alert);
  assert.deepEqual(box.sent.slice(-2), ["[alert-bridge-recovered] 43 firing", "[alert-bridge-recovered] 48 firing"]);
  assert.ok((await box.entries()).every(entry => entry.state === "delivered"));
});

test("a long entry already on disk from before the fix goes in parts, and the message behind it is no longer held", async t => {
  const alert = escalation(260);
  const stored = (id: string, text: string, at: number) => ({ id, threadId: OPS, text, images: [], mode: "steer", fingerprint: `${OPS}\n${text}`,
    kind: "message", root: OPS, imageCount: 0, state: "queued", at, attempts: 16 });
  const box = await setup(t, [stored("m-long", alert, 1792424783100), stored("m-after", "[alert-bridge-recovered] 44 firing", 1792424804207)]);
  await box.outbox.outbox.idle();
  assert.ok(box.sent.every(text => text.length <= DAEMON_MESSAGE_LIMIT));
  assert.ok(box.sent.some(text => text.endsWith("\n\n[alert-bridge-recovered] 44 firing")));
  assert.equal(box.sent.filter(text => text.startsWith("[part ")).map(body).join(""), alert);
  const long = (await box.entries()).find(entry => entry.text === alert)!;
  assert.equal(long.state, "obsolete");
  assert.match(long.error ?? "", /over the daemon's 16384, so it goes as m-/);
});
