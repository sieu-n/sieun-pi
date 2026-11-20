import assert from "node:assert/strict";
import { test } from "node:test";
import piHistoryExtension, { hitLine, resultText, SEARCH_HISTORY_TOOL, socketFilters } from "../src/pi/index.ts";

test("the Pi extension registers search_history", () => {
  const names: string[] = [];
  piHistoryExtension({ registerTool: tool => { names.push(tool.name); } });
  assert.deepEqual(names, [SEARCH_HISTORY_TOOL]);
});

test("a hit prints as one line with its time, box, thread, session, kind, plain snippet and ref", () => {
  const line = hitLine({ ref: "us-metal02:01a16f2c-0000-7000-8000-000000000000@1792761612000#1835187890688000", box: "us-metal02", source: "prime",
    session: "01a16f2c-0000-7000-8000-000000000000", root: "01a16f2c-0000-7000-8000-000000000000", depth: 1, thread: "hosts relay timeout job", rootName: "frontend-bro",
    kind: "tool_result", tool: "bash", author: "frontend-bro", at: Date.parse("2026-10-23T13:20:12Z"), snippet: "…relay mac <mark>did</mark> not answer &#60;15000 ms&#62;…" });
  assert.equal(line, "2026-10-23 13:20Z us-metal02 frontend-bro/hosts relay timeout job (01a16f2c) tool_result (bash): …relay mac did not answer <15000 ms>… " +
    "ref=us-metal02:01a16f2c-0000-7000-8000-000000000000@1792761612000#1835187890688000");
  assert.match(resultText({ hits: [], total: 0, tookMs: 3, scope: "family", boxes: { mac: { ok: false, error: "timeout", tookMs: 5000, backfillPct: 0 } } }),
    /^0 of 0 hits, 3 ms, scope family\. Not searched: mac \(timeout\)\. Try fewer words/);
});

test("the shared filters become the socket's params: from and in as lists, where=tool as kind, after keeps its day and before leaves it out", () => {
  assert.deepEqual(socketFilters({ from: ["vent", "owner"], in: "sw-factory-build", where: ["tool"], after: "2026-11-19", before: "2026-11-20" }),
    { agent: "vent,owner", chat: "sw-factory-build", kind: "tool", since: "2026-11-19", until: "2026-11-19T15:00:00.000Z" });
  assert.deepEqual(socketFilters({ before: "2026-11-20T03:00:00Z", kind: "thinking" }), { agent: undefined, chat: undefined, kind: "thinking", since: undefined, until: "2026-11-20T03:00:00Z" });
  assert.throws(() => socketFilters({ where: ["thread"] }), /search_messages/);
  assert.throws(() => socketFilters({ where: "tool", kind: "thinking" }), /not both/);
});
