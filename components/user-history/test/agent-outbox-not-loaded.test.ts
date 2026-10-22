// Guards the 10-21 "Unknown active session" refusals: from 11:41Z to 15:40Z the outbox sent 17 wakes and messages straight to child sessions
// the daemon's list showed with no worker of their own, the supervisor refused each one, and only then did the outbox relay it to the parent.
// A child the list shows as not loaded now goes to its parent with no direct send; a loaded child, or one no list holds, still gets the send.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sessionFileOf } from "../src/send-once.ts";
import { relayNote } from "../src/subagent-relay.ts";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { relayRecord } from "../src/chat-sources.ts";

const ROOT = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const CHILD = "01a14d48-9bd2-70da-9bd4-7eaf792eefe2";

async function tree(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "outbox-not-loaded-"));
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(agentDir, "sessions", `${ROOT}.jsonl`), "");
  const child = join(agentDir, "session-artifacts", ROOT, "sub-740c5dc9");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, `${CHILD}.jsonl`), "");
  await writeFile(join(child, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", sessionName: "p8-metal" }));
  return agentDir;
}

/** An outbox whose daemon takes every send and whose list shows each session of `resident` with that residency. */
function outbox(t: TestContext, agentDir: string, resident: Map<string, boolean>, sent: [string, string][], now = () => Date.parse("2026-10-21T11:41:20Z")) {
  const relays = relayRecord(join(agentDir, "relayed.json"));
  const messages = new AgentOutbox(join(agentDir, "agent-outbox"), { log: () => {}, sleep: () => new Promise(done => setImmediate(done)), now,
    relayed: (session, at) => relays.add(session, at),
    send: async (session, text) => { sent.push([session, text]); return "sent"; },
    target: async () => ({ queued: [], busy: false }), fileOf: id => sessionFileOf(id, agentDir),
    resident: session => resident.get(session) ?? null });
  t.after(() => messages.close());
  return Object.assign(messages, { relays });
}

const wake = "[wake] It is 2026-10-21T11:41:14Z, the time you set with board.wake (11:41Z).";

test("a wake to a child the list shows as not loaded goes to its parent with no direct send", async t => {
  const agentDir = await tree();
  const sent: [string, string][] = [];
  const messages = outbox(t, agentDir, new Map([[CHILD, false], [ROOT, true]]), sent);
  await messages.deliver(CHILD, wake);
  await messages.outbox.idle();
  assert.deepEqual(sent, [[ROOT, relayNote({ id: CHILD, name: "p8-metal" }, wake)]]);
  assert.equal(await messages.relays.at(CHILD), Date.parse("2026-10-21T11:41:20Z"), "the relay is on record, so the job cleanup keeps the child until it runs");
});

test("a wake to a loaded child, or to one no list holds, still goes to the child", async t => {
  const agentDir = await tree();
  const sent: [string, string][] = [];
  const resident = new Map([[CHILD, true], [ROOT, true]]);
  const messages = outbox(t, agentDir, resident, sent);
  await messages.deliver(CHILD, wake);
  await messages.outbox.idle();
  resident.delete(CHILD);
  await messages.deliver(CHILD, wake + " Again.");
  await messages.outbox.idle();
  assert.deepEqual(sent.map(([session]) => session), [CHILD, CHILD]);
  assert.equal(await messages.relays.at(CHILD), undefined, "a direct send leaves no relay on record");
});
