// us-metal02, 10-27: the OOM hang from 15:14Z ended in worker recoveries at 16:48:54Z, and the daemon stopped at 16:55:06Z and 17:07:46Z.
// ctl-fix (01a17d82) kept its parent's 15:01:29Z message with a pi-pool queue place and then the recovery notice, and lastCut read the queue
// place as a turn still to come, so the chat named no cut and the job sweep never looked at the archived job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cutEnd, resumesNow } from "../src/cut-end.ts";

const line = (entry: object) => JSON.stringify(entry);
const at = (clock: string) => Date.parse(`2026-10-27T${clock}Z`);
const message = (clock: string) => line({ type: "custom_message", customType: "agent_message", timestamp: `2026-10-27T${clock}Z`, content: "[agent-message from parent]" });
const queued = (clock: string) => line({ type: "custom", customType: "pi-pool-queue", timestamp: `2026-10-27T${clock}Z`, data: { position: 153 } });
const recovery = (clock: string) => line({ type: "custom_message", customType: "prime-agent.worker_recovery", timestamp: `2026-10-27T${clock}Z`, content: "x" });
const archived = (clock: string, reason: string) => line({ type: "session_state", timestamp: `2026-10-27T${clock}Z`, state: { status: "archived", reason } });
const reply = (clock: string, stopReason: string) => line({ type: "message", timestamp: `2026-10-27T${clock}Z`, message: { role: "assistant", stopReason, content: [] } });

test("a message a worker recovery left with no turn is a cut the sweep resumes now", () => {
  const ctlFix = [reply("14:36:34.201", "error"), archived("14:37:30.685", "completed"), message("15:01:29.374"), queued("15:01:29.395"), recovery("16:48:54.792")];
  const cut = cutEnd(ctlFix);
  assert.deepEqual(cut, { at: at("15:01:29.374"), cause: "recovered" });
  assert.equal(resumesNow(cut!, at("16:50:00")), true);
});

test("an empty abort the daemon shutdown wrote is a recovered cut, with no restart proof needed", () => {
  const cut = cutEnd([message("16:49:59.550"), queued("16:49:59.559"), archived("16:55:05.895", "daemon_shutdown"), reply("16:55:05.960", "aborted")]);
  assert.deepEqual(cut, { at: at("16:55:05.960"), cause: "recovered" });
});

test("a queued message with no recovery after it, or a turn after the recovery, is no cut", () => {
  assert.equal(cutEnd([message("17:03:05.565"), queued("17:03:05.647")]), null);
  assert.equal(cutEnd([message("15:01:29.374"), recovery("16:48:54.792"), message("17:03:10.051"), queued("17:03:10.064")]), null);
  assert.equal(cutEnd([message("15:01:29.374"), recovery("16:48:54.792"), reply("17:04:00", "stop")]), null);
  assert.deepEqual(cutEnd([reply("16:00:00", "aborted"), archived("16:00:00.001", "owner_stop")]), null, "an owner's archive after the abort is no cut");
});
