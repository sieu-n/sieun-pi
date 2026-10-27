import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extract, sessionOfPath } from "../src/core/extract.ts";

const lines = readFileSync(new URL("./fixtures/own-session.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const docsOf = (i: number) => extract(lines[i]).docs;

test("the session line gives the header and no docs", () => {
  const x = extract(lines[0]);
  assert.deepEqual(x.docs, []);
  assert.equal(x.header?.id, "01a17f78-722f-77dd-a3c2-1fdbbc3a2346");
  assert.equal(x.header?.cwd, "/Users/sieunpark/Documents/Github/sieun-pi");
  assert.equal(x.header?.created, Date.parse("2026-10-27T22:26:02.415Z"));
  assert.equal(sessionOfPath(x.header!.parentSession!), "01a17f5f-620d-737f-8e1e-5731368372f2");
});

test("session_info gives the name", () => {
  assert.equal(extract(lines[1]).name, "indexer");
});

test("a harness digest and bookkeeping entries give no docs", () => {
  assert.deepEqual(docsOf(2), []);
  assert.deepEqual(docsOf(7), []);
  assert.deepEqual(docsOf(8), []);
});

test("agent messages name their sender", () => {
  const [task] = docsOf(3);
  assert.equal(task!.kind, "agent_message");
  assert.equal(task!.author, "parent");
  assert.match(task!.text, /^\[task from parent\]/);
  const [msg] = docsOf(4);
  assert.equal(msg!.author, "d376335a1a81");
});

test("an assistant message splits into thinking and a tool call, with the signature dropped", () => {
  const docs = docsOf(5);
  assert.deepEqual(docs.map((d) => d.kind), ["thinking", "tool_call"]);
  assert.equal(docs[0]!.author, null);
  assert.ok(!docs.some((d) => d.text.includes("SIG")));
  const call = docs[1]!;
  assert.equal(call.tool, "ipython");
  assert.equal(call.toolCallId, "toolu_011ssYCTofWMQddddKGAue1X");
  assert.match(call.text, /^import os, json/);
});

test("a tool result keeps its text whole, without the details copy", () => {
  const [r] = docsOf(6);
  assert.equal(r!.kind, "tool_result");
  assert.equal(r!.tool, "ipython");
  assert.equal(r!.toolCallId, "toolu_011ssYCTofWMQddddKGAue1X");
  assert.equal(r!.isError, false);
  assert.equal(r!.text, lines[6].message.content[0].text);
});

test("a user message keeps its text and skips the base64 image", () => {
  const [u] = docsOf(9);
  assert.equal(u!.kind, "user");
  assert.equal(u!.author, "owner");
  assert.equal(u!.text, "검색 패널 보여줘 please");
});

test("a non-boilerplate custom message is a notice, a compaction is a summary, an error result is flagged", () => {
  assert.deepEqual(docsOf(10).map((d) => [d.kind, d.tool, d.author]), [["notice", "async_bash_completion", "system"]]);
  assert.deepEqual(docsOf(11).map((d) => d.kind), ["summary"]);
  assert.equal(docsOf(12)[0]!.isError, true);
});

test("only transcript names count as sessions", () => {
  assert.equal(sessionOfPath("/x/2026-10-27T17-17-03-648Z_01a17e5d-911d-7707-ae6f-12e3c2b90c46.jsonl"), "01a17e5d-911d-7707-ae6f-12e3c2b90c46");
  assert.equal(sessionOfPath("/x/semantic-edges.jsonl"), undefined);
});
