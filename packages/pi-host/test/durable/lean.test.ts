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

test("a lean entry drops a thinking block's signature and keeps its thinking text", () => {
  const lean = leanEntry(entry([
    { role: "assistant", content: [{ type: "thinking", thinking: "plan", thinkingSignature: "S".repeat(3000) }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
  ])) as unknown as { model: { content: unknown[] }[] };
  assert.deepEqual(lean.model[0]!.content, [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]);
});

test("an entry with nothing to cut comes back as the same object", () => {
  const plain = entry([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
  assert.equal(leanEntry(plain), plain);
  const bare = { id: 1, kind: "pi.system", conversationId: 1 } as unknown as EntryRecord;
  assert.equal(leanEntry(bare), bare);
});

test("a lean system message keeps its role, text and time and drops its prompt sections and tool lists", () => {
  const system = { role: "system", content: "", sections: Array.from({ length: 40 }, (_, i) => ({ key: `s${i}`, text: "p".repeat(5000) })), toolsAdded: [{ name: "bash" }], toolsRemoved: ["x"], timestamp: 5 };
  const lean = leanEntry({ id: 4, kind: "pi.system", conversationId: 1, model: [system] } as unknown as EntryRecord) as unknown as { model: unknown[] };
  assert.deepEqual(lean.model[0], { role: "system", content: "", timestamp: 5 });
  const bare = { id: 5, kind: "pi.system", conversationId: 1, model: [{ role: "system", content: "short", timestamp: 6 }] } as unknown as EntryRecord;
  assert.equal(leanEntry(bare), bare);
});
