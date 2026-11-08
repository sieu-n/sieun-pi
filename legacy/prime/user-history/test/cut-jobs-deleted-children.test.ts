// Guards d7's loop stalls on us-metal02 on 10-20: findCutJobs scanned a whole parent chat transcript (68 to 114 MB) once per child job to
// find its delete_subagent result, and held the chat's event loop 0.4 to 0.57 s at a time in the live chat's CPU profile. On 11-08 at 09:20Z
// the one scan still held it 1.42 s: per spawn result it searched for "delete_subagent" to the end of the file when no later delete existed.
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

/** Runs `run` and returns how many bytes Buffer indexOf and lastIndexOf read, up to the end of a match or of the searched range. */
function bytesSearched(run: () => void): number {
  const { indexOf, lastIndexOf } = Buffer.prototype;
  const size = (value: string | number | Uint8Array) => typeof value === "number" ? 1 : Buffer.byteLength(value as string);
  let bytes = 0;
  Buffer.prototype.indexOf = function (this: Buffer, value: string | number | Uint8Array, from = 0) {
    const found = indexOf.call(this, value, from);
    bytes += found < 0 ? this.length - from : found + size(value) - from;
    return found;
  } as typeof indexOf;
  Buffer.prototype.lastIndexOf = function (this: Buffer, value: string | number | Uint8Array, from = this.length) {
    const found = lastIndexOf.call(this, value, from);
    bytes += found < 0 ? from : from - found;
    return found;
  } as typeof lastIndexOf;
  try { run(); } finally { Object.assign(Buffer.prototype, { indexOf, lastIndexOf }); }
  return bytes;
}

test("a transcript of many spawn results and no delete_subagent is read a few times over, not once per spawn", () => {
  const parts: string[] = [];
  for (let i = 0; i < 2000; i++) parts.push(call("ipython", `await rlm.spawn('job ${i}', name='j${i}')`), result(`{'rlm_child_id': 'sub-${i}'} rlm_child_id='sub-${i}'`));
  const text = Buffer.from(parts.join(""));
  let deleted = new Set<string>();
  const bytes = bytesSearched(() => { deleted = deletedChildren(text); });
  assert.equal(deleted.size, 0);
  assert.ok(bytes < 3 * text.length, `searched ${bytes} bytes of a ${text.length} byte transcript`);
});
