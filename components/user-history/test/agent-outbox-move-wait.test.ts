// Guards 10-26 06:07Z on us-metal02: a wake to the job reasons-fix (01a172c1) met "Active session ... is closing" at 05:59:53Z and went through
// its parent 2 s later, which left the move on record, so the next wake, queued at 06:07:22.6Z and sent 0.4 s later, logged "went after its
// target's worker was closing for 450 s" and the Whole system precheck counted that minute dirty, though no send waited.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";

const JOB = "01a172c1-169e-761a-ab25-bcf9571a0b37";
const PARENT = "01a1695d-0000-7000-8000-000000000001";

test("a send after a move that ended through the parent logs its own wait, not the time since the move", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outbox-move-wait-"));
  const lines: string[] = [];
  let now = Date.parse("2026-10-26T05:59:53.001Z");
  let resident = true;
  let closing = true;
  const sent: string[] = [];
  const outbox = new AgentOutbox(dir, {
    log: line => { lines.push(line); },
    now: () => now,
    sleep: () => new Promise(done => setImmediate(done)),
    send: async (session, text) => {
      if (session === JOB && closing) { closing = false; resident = false; throw new Error(`Active session ${JOB} is closing`); }
      sent.push(`${session.slice(0, 8)} ${text.slice(0, 20)}`);
      return "sent";
    },
    target: async () => ({ queued: [], busy: false }),
    fileOf: async () => null,
    resident: session => session === JOB ? resident : true,
    subagentOf: async session => session === JOB ? { id: JOB, name: "reasons-fix", parents: [PARENT] } : null,
  });
  await outbox.deliver(JOB, "[wake] first", undefined, "wake");
  await outbox.outbox.idle();
  assert.ok(sent.some(line => line.startsWith("01a1695d [relay]")), sent.join("\n"));
  now = Date.parse("2026-10-26T06:07:22.624Z");
  resident = true;
  await outbox.deliver(JOB, "[wake] second", undefined, "wake");
  await outbox.outbox.idle();
  await outbox.close();
  const went = lines.find(line => line.includes("went after its target's worker"));
  assert.ok(went, lines.join("\n"));
  assert.match(went, /was closing for 0 s$/);
  const at = new Date(now).toISOString();
  assert.deepEqual(readServiceFaults([`${at} ${went}`], "us-metal02"), []);
});
