// Guards the 10-27 followUpMode change: Prime reads the queue modes from settings.json only when it loads a session, so prime-sync sets a
// changed mode on every loaded session through `daemon-cli.mjs modes`, and a session the daemon refuses is counted, not retried.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daemonSetModes } from "../src/daemon-list.ts";
import { parseModes } from "../src/daemon-cli.ts";

test("every loaded session with a worker gets each mode, and a refusal is counted", async () => {
  const sent: { type: string; activeSessionId?: string; mode?: string }[] = [];
  const rows = [{ activeSessionId: "w1" }, { activeSessionId: "w2", workerState: "failed" }, { sessionId: "saved" }, { activeSessionId: "w3" }];
  const client = {
    async request(command: { type: string; activeSessionId?: string; mode?: string }) {
      sent.push(command);
      if (command.type === "list") return { success: true, data: { sessions: rows } };
      if (command.activeSessionId === "w3") return { success: false, error: "Unknown active session: w3" };
      return { success: true };
    },
    close() {},
  };
  const result = await daemonSetModes({ followUpMode: "all" }, async () => client as never);
  assert.deepEqual(result, { sessions: 2, set: 1, failed: [{ activeSessionId: "w3", error: "Unknown active session: w3" }] });
  assert.deepEqual(sent.filter(command => command.type !== "list"), [
    { type: "set_follow_up_mode", activeSessionId: "w1", mode: "all" },
    { type: "set_follow_up_mode", activeSessionId: "w3", mode: "all" },
  ]);
});

test("modes words name a known mode and value", () => {
  assert.deepEqual(parseModes(["followUpMode=all", "steeringMode=one-at-a-time"]), { followUpMode: "all", steeringMode: "one-at-a-time" });
  assert.throws(() => parseModes(["followUpMode=some"]), /usage/);
  assert.throws(() => parseModes(["theme=all"]), /usage/);
});
