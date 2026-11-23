import assert from "node:assert/strict";
import { test } from "node:test";
import { effortOffDefault } from "../scripts/duties/whole-system.ts";

const want = { model: "claude-opus-5-5", thinking: "high" };
const copy = (host: string, rows: object[]) => ({ host, text: JSON.stringify({ version: 1, fullAt: 0, rows }) });
const opus = { id: "claude-opus-5-5", provider: "anthropic" };

test("sessions_off_high counts each live loaded session off the default, and leaves out unloaded and archived rows", () => {
  const read = effortOffDefault([copy("us-metal02", [
    { lifecycle: "live", sessionId: "01a11b0b-aaaa", sessionName: "slack green guy", model: opus, thinkingLevel: "off" },
    { lifecycle: "live", sessionId: "01a1f880-bbbb", sessionName: "on high", model: opus, thinkingLevel: "high" },
    { lifecycle: "live", sessionId: "01a1f881-cccc", sessionName: "fable", model: "claude-fable-5-2", thinkingLevel: "high" },
    { lifecycle: "live", sessionId: "01a1f882-dddd", sessionName: "unloaded", model: null, thinkingLevel: null },
    { lifecycle: "archived", sessionId: "01a1f883-eeee", model: opus, thinkingLevel: "low" },
  ])], want, () => false);
  assert.deepEqual(read.off.map(entry => [entry.name, entry.model, entry.thinking]), [["slack green guy", "claude-opus-5-5", "off"], ["fable", "claude-fable-5-2", "high"]]);
  assert.deepEqual(read.read, ["us-metal02"]);
  assert.deepEqual(read.unread, []);
});

test("sessions_off_high reads an offline box as unread, never as 0 off", () => {
  const read = effortOffDefault([
    copy("us-metal02", [{ lifecycle: "live", sessionId: "01a1f880-bbbb", model: opus, thinkingLevel: "high" }]),
    copy("mac", [{ lifecycle: "live", sessionId: "01a11b0b-aaaa", model: opus, thinkingLevel: "off" }]),
    { host: "piscratch", text: "" },
  ], want, host => host === "mac");
  assert.equal(read.off.length, 0);
  assert.deepEqual(read.read, ["us-metal02"]);
  assert.deepEqual(read.unread, ["mac", "piscratch"]);
});

test("sessions_off_high leaves out d2's chat page probe thread, which runs at thinking off on purpose", () => {
  const read = effortOffDefault([copy("mac", [
    { lifecycle: "live", sessionId: "01a208ba-aaaa", sessionName: "chat page probe 14:06", model: opus, thinkingLevel: "off" },
    { lifecycle: "live", sessionId: "01a208bb-bbbb", sessionName: "probe notes", model: opus, thinkingLevel: "off" },
  ])], want, () => false);
  assert.deepEqual(read.off.map(entry => entry.name), ["probe notes"]);
});
