// Guards us-metal02 10-18 22:15Z to 23:18Z: the wakes to "metal box owner" (01a11d24), a root moved from the Mac with no worker on this box,
// timed out at the daemon's 30 s, and every get_state of it hung after that, so the copy check read "unknown" and its lane held every later
// send for an hour. A daemon create opened it in 1.6 s at 23:18Z, and a send then went at once.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";

const METAL = "01a11d24-ac9b-757d-ac51-9b2b7598782f";
const WAKE = "[wake] Run 39166743585 finished: failure (land.yml on sieun/dev). https://github.com/sieu-n/auto-sns-agent/actions/runs/39166743585";
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message".';

async function run(open: (() => Promise<boolean>) | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-open-"));
  let opened = false, looks = 0, opens = 0;
  const sent: string[] = [];
  const lines: string[] = [];
  const outbox = new AgentOutbox(dir, {
    log: line => { lines.push(line); },
    send: async (_session, text) => {
      if (!opened) throw new Error(TIMEOUT);
      sent.push(text);
      return "sent";
    },
    target: async () => { looks++; return opened ? { queued: [], busy: false } : null; },
    fileOf: async () => null,
    ...open ? { open: async () => { opens++; opened = await open(); return opened; } } : {},
    sleep: () => new Promise(done => setImmediate(done)),
  });
  await outbox.deliver(METAL, WAKE, undefined, "wake");
  for (let i = 0; i < 200 && !sent.length && looks < 20; i++) await new Promise(done => setTimeout(done, 2));
  await outbox.close();
  return { sent, opens, looks, lines };
}

test("a send that may have gone to a root with no worker, whose get_state does not answer, opens it from its file and goes once", async () => {
  const { sent, opens, lines } = await run(async () => true);
  assert.deepEqual(sent, [WAKE]);
  assert.equal(opens, 1);
  assert.ok(lines.some(line => line.includes("had no worker; opened it from its file")), lines.join("\n"));
});

test("a target that cannot be opened (a hung worker) keeps the send waiting and sends nothing again", async () => {
  const { sent, opens, looks } = await run(async () => false);
  assert.deepEqual(sent, []);
  assert.ok(opens >= 1 && looks >= 1);
});
