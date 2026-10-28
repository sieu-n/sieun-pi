// Guards direct delivery to a stopped subagent. Since Prime load.3 (us-metal02, 10-28 08:59:53Z) a send_message by a subagent's full id opens
// its tree from the spawn ledger and lands with no parent turn. The outbox still skipped the send for a child the list showed with no worker of
// its own and relayed it: from 09:00:07Z to 09:02:36Z on 10-28 the wakes to dev tip keeper (01a18121) and duties card read slow (01a1817a)
// went through their parents with no try. A Prime before load.3 (the Mac's load.2.1) answers "Unknown active session", and only then the
// message goes to the parent.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sessionFileOf } from "../src/send-once.ts";
import { relayNote } from "../src/subagent-relay.ts";
import { AgentOutbox, type AgentOutboxDeps } from "../src/agent-outbox.ts";
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

/** An outbox whose daemon answers each send with `answer`, while its list shows the child with no worker of its own. */
function outbox(t: TestContext, agentDir: string, sent: [string, string][], answer: (session: string) => "sent" | "gone") {
  const relays = relayRecord(join(agentDir, "relayed.json"));
  // The catalog's residency as the outbox of 2da50673 read it, which relayed such a child with no send; the outbox reads it no more.
  const deps: AgentOutboxDeps & { resident: (session: string) => boolean } = { log: () => {}, sleep: () => new Promise(done => setImmediate(done)),
    now: () => Date.parse("2026-10-28T09:02:35Z"),
    relayed: (session, at) => relays.add(session, at),
    send: async (session, text) => { sent.push([session, text]); return answer(session); },
    target: async () => ({ queued: [], busy: false }), fileOf: id => sessionFileOf(id, agentDir),
    resident: session => session !== CHILD };
  const messages = new AgentOutbox(join(agentDir, "agent-outbox"), deps);
  t.after(() => messages.close());
  return Object.assign(messages, { relays });
}

const wake = "[wake] It is 2026-10-28T09:02:35Z, the time you set with board.wake (09:02Z).";

test("a wake to a stopped child goes straight to it when its daemon opens it (Prime load.3)", async t => {
  const agentDir = await tree();
  const sent: [string, string][] = [];
  const messages = outbox(t, agentDir, sent, () => "sent");
  await messages.deliver(CHILD, wake);
  await messages.outbox.idle();
  assert.deepEqual(sent, [[CHILD, wake]]);
  assert.equal(await messages.relays.at(CHILD), undefined, "a direct send leaves no relay on record");
});

test("a wake to a stopped child its daemon does not open goes to its parent (Prime before load.3)", async t => {
  const agentDir = await tree();
  const sent: [string, string][] = [];
  const messages = outbox(t, agentDir, sent, session => session === CHILD ? "gone" : "sent");
  await messages.deliver(CHILD, wake);
  await messages.outbox.idle();
  assert.deepEqual(sent, [[CHILD, wake], [ROOT, relayNote({ id: CHILD, name: "p8-metal" }, wake)]]);
  assert.equal(await messages.relays.at(CHILD), Date.parse("2026-10-28T09:02:35Z"), "the relay is on record, so the job cleanup keeps the child until it runs");
});
