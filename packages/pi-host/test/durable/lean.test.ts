import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { LEAN_TEXT, leanEntry } from "../../src/durable/lean.ts";

const entry = (model: unknown[]): EntryRecord => ({ id: 7, kind: "pi.tool-result", conversationId: 1, model } as unknown as EntryRecord);

test("a lean entry keeps an image block's mimeType and drops its data", () => {
  const lean = leanEntry(entry([{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "shot" }, { type: "image", data: "A".repeat(5000), mimeType: "image/png" }] }]));
  assert.deepEqual((lean as { model: { content: unknown[] }[] }).model[0]!.content, [{ type: "text", text: "shot" }, { type: "image", data: "", mimeType: "image/png" }]);
});

test("a lean entry cuts tool result and system text past LEAN_TEXT and keeps assistant and user text whole", () => {
  const long = "x".repeat(LEAN_TEXT + 500);
  const lean = leanEntry(entry([
    { role: "toolResult", content: [{ type: "text", text: long }] },
    { role: "system", content: long },
    { role: "assistant", content: [{ type: "text", text: long }, { type: "thinking", thinking: long }] },
    { role: "user", content: long },
  ])) as unknown as { model: { content: unknown }[] };
  assert.equal((lean.model[0]!.content as { text: string }[])[0]!.text, `${"x".repeat(LEAN_TEXT)}\n...`);
  assert.equal(lean.model[1]!.content, `${"x".repeat(LEAN_TEXT)}\n...`);
  assert.equal(((lean.model[2]!.content as { text: string }[])[0]!).text, long);
  assert.equal(lean.model[3]!.content, long);
});

test("an entry with nothing to cut comes back as the same object", () => {
  const plain = entry([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
  assert.equal(leanEntry(plain), plain);
  const bare = { id: 1, kind: "pi.system", conversationId: 1 } as unknown as EntryRecord;
  assert.equal(leanEntry(bare), bare);
});
