// Guards the 10-18 05:00Z drops: the wake ticker dropped the wakes of five stopped Crawler VP subagents ("dropped, no such session"), because
// the daemon finds a subagent only while its tree's worker holds it. The text now goes to the parent, whose rlm handle reopens the child.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionFileOf } from "../src/send-once.ts";
import { deliverThroughParent, relayNote, stoppedSubagent } from "../src/subagent-relay.ts";

const ROOT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const PARENT = "01a14c59-e9e8-7454-9543-5cd6ffccd7d1";
const CHILD = "01a14cce-dbce-7438-b719-9d2f59322c16";

async function tree(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "subagent-relay-"));
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(agentDir, "sessions", `${ROOT}.jsonl`), "");
  const parent = join(agentDir, "session-artifacts", ROOT, "sub-9a985a9c");
  const child = join(parent, "sub-fef56e2c");
  await mkdir(child, { recursive: true });
  await writeFile(join(parent, `${PARENT}.jsonl`), "");
  await writeFile(join(parent, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", sessionName: "crawler prod alerts" }));
  await writeFile(join(child, `${CHILD}.jsonl`), "");
  await writeFile(join(child, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", sessionName: "alerts-h-proxy" }));
  return agentDir;
}

test("a subagent's file names its rlm handle and the sessions above it", async () => {
  const agentDir = await tree();
  assert.deepEqual(await stoppedSubagent((await sessionFileOf(CHILD, agentDir))!), { id: CHILD, name: "alerts-h-proxy", parents: [PARENT, ROOT] });
  assert.equal(await stoppedSubagent(join(agentDir, "sessions", `${ROOT}.jsonl`)), null);
});

test("a send the daemon answers gone for goes to the parent, and through the grandparent when the parent is gone too", async () => {
  const agentDir = await tree();
  const sent: [string, string][] = [];
  const live = new Set([ROOT]);
  const deliver = async (session: string, text: string): Promise<"sent" | "gone"> => { sent.push([session, text]); return live.has(session) ? "sent" : "gone"; };
  const deps = { fileOf: (id: string) => sessionFileOf(id, agentDir), deliver };
  const wake = "[wake] It is 2026-10-18T05:00:00Z, the time you set with board.wake.";
  assert.equal(await deliverThroughParent(CHILD, wake, deps), "sent");
  const toParent = relayNote({ id: CHILD, name: "alerts-h-proxy" }, wake);
  assert.deepEqual(sent, [[CHILD, wake], [PARENT, toParent], [ROOT, relayNote({ id: PARENT, name: "crawler prod alerts" }, toParent)]]);
  assert.match(toParent, /receiver_name="alerts-h-proxy"/);

  sent.length = 0;
  live.add(PARENT);
  assert.equal(await deliverThroughParent(CHILD, wake, deps), "sent");
  assert.deepEqual(sent.map(([session]) => session), [CHILD, PARENT]);
});

test("a root the daemon answers gone for stays gone", async () => {
  const agentDir = await tree();
  const deliver = async (): Promise<"sent" | "gone"> => "gone";
  assert.equal(await deliverThroughParent(ROOT, "continue", { fileOf: id => sessionFileOf(id, agentDir), deliver }), "gone");
});
