// Guards d7's loop stalls on us-metal02 on 10-20: findCutJobs scanned a whole parent chat transcript (68 to 114 MB) once per child job to
// find its delete_subagent result, and held the chat's event loop 0.4 to 0.57 s at a time in the live chat's CPU profile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deletedChildren } from "../scripts/duties/whole-system.ts";

const line = (value: object): string => JSON.stringify(value) + "\n";
const call = (name: string, code: string) => line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: { code } }] } });
const result = (text: string) => line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });

test("one scan of a parent transcript names every child a delete_subagent call deleted, and no child it only spawned or mentioned", () => {
  const filler = line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] } });
  const parts: string[] = [];
  for (let i = 0; i < 300; i++) {
    parts.push(call("ipython", `await rlm.spawn('job ${i}', name='j${i}')`), result(`{'rlm_child_id': 'sub-${i}', 'name': 'j${i}'}`), filler);
    parts.push(call("ipython", `print(\"rlm_child_id='sub-${i}'\")`), result(`rlm_child_id='sub-${i}' spawned`));
  }
  for (const i of [3, 150, 299]) parts.push(call("ipython", "await rlm.delete_subagent(child)"), result(`{'deleted': True, rlm_child_id='sub-${i}'}`));
  const deleted = deletedChildren(Buffer.from(parts.join("")));
  assert.deepEqual([...deleted].sort(), ["sub-150", "sub-299", "sub-3"]);
});

test("a transcript with no child id, or an id with no closing quote, deletes nothing", () => {
  assert.deepEqual(deletedChildren(Buffer.from(call("ipython", "await rlm.delete_subagent(child)") + result("done"))).size, 0);
  assert.deepEqual(deletedChildren(Buffer.from(call("ipython", "await rlm.delete_subagent(child)") + "rlm_child_id='sub-1")).size, 0);
});
