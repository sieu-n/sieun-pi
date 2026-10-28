import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseQuery } from "../src/core/query.ts";
import { mergePages, pageAsk, searchDurable, searchPrime } from "../src/core/search.ts";
import { parseRef, readDurable, readPrime } from "../src/core/read.ts";
import { makeDurable, makeIndex } from "./fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-history-search-"));
const T = Date.parse("2026-10-20T00:00:00Z");
const min = (n: number): number => T + n * 60_000;
const CHAT = "01a10000-0000-7000-8000-000000000001";
const JOB = "01a10001-0000-7000-8000-000000000002";
const SUB = "01a10002-0000-7000-8000-000000000003";
const OTHER = "01a20000-0000-7000-8000-000000000004";
const build = (ftsKind: boolean, docsMeta: boolean) => makeIndex(join(dir, `h-${ftsKind}-${docsMeta}.db`), [
  { session: CHAT, name: "frontend bro" },
  { session: JOB, name: "relay timeout job" },
  { session: SUB, root: JOB, parent: JOB, depth: 1, name: "relay probe" },
  { session: OTHER, name: "crawler VP" },
], [
  { session: CHAT, at: min(1), kind: "user", text: "why did the relay <time out>?" },
  { session: JOB, at: min(2), kind: "tool_result", tool: "bash", toolCallId: "call-1", text: "relay mac did not answer in 15000 ms", isError: true },
  { session: SUB, at: min(3), kind: "assistant", text: "the relay probe answered fine" },
  { session: SUB, at: min(3), kind: "thinking", text: "maybe the relay is slow" },
  { session: OTHER, at: min(4), kind: "agent_message", author: "parent", text: "relay relay relay relay" },
  { session: OTHER, at: min(5), kind: "tool_call", tool: "bash", text: "curl the relay health" },
  { session: JOB, at: min(6), kind: "assistant", text: `job ${CHAT.slice(0, 8)} report` },
], { ftsKind, docsMeta });

for (const [ftsKind, docsMeta] of [[false, false], [true, false], [true, true]] as const) {
  const db = build(ftsKind, docsMeta);
  const label = `${ftsKind ? "fts with kind" : "fts text only"}${docsMeta ? ", docs_meta" : ""}`;
  const newest = (q: string, roots: string[] | null = null, limit = 20) => searchPrime(db, "us-metal02", parseQuery({ q }), pageAsk("newest", limit, null), roots);

  test(`${label}: newest first walks entry time backwards, leaves thinking out and counts every hit`, () => {
    const page = newest("relay");
    assert.deepEqual(page.hits.map(item => item.hit.at), [min(5), min(4), min(3), min(2), min(1)]);
    assert.equal(page.total, 5);
    const first = page.hits.at(-1)!.hit;
    assert.equal(first.ref, `us-metal02:${CHAT}@${min(1)}#${min(1) * 1024}`);
    assert.equal(first.thread, "frontend bro");
    assert.equal(first.author, "owner");
    const sub = page.hits.find(item => item.hit.session === SUB)!.hit;
    assert.equal(sub.root, JOB);
    assert.equal(sub.rootName, "relay timeout job");
    assert.equal(sub.depth, 1);
    const tool = page.hits.find(item => item.hit.session === JOB)!.hit;
    assert.deepEqual([tool.kind, tool.tool, tool.toolCallId, tool.isError], ["tool_result", "bash", "call-1", true]);
    assert.equal(newest("relay kind:thinking").total, 1);
  });

  test(`${label}: snippets are HTML-escaped with <mark> around the match`, () => {
    const hit = newest("time").hits[0]!.hit;
    assert.equal(hit.snippet, "why did the relay &#60;<mark>time</mark> out&#62;?");
  });

  test(`${label}: relevant ranks by bm25 times the kind weight within the newest hits`, () => {
    const page = searchPrime(db, "us-metal02", parseQuery({ q: "relay" }), pageAsk("relevant", 20, null), null);
    assert.equal(page.hits[0]!.hit.kind, "agent_message");
    const kinds = page.hits.map(item => item.hit.kind);
    assert.ok(kinds.indexOf("user") < kinds.indexOf("tool_result"), kinds.join());
    assert.equal(page.total, 5);
    const ask = pageAsk("relevant", 20, null);
    const merged = mergePages([page], ask);
    const scores = merged.hits.map(hit => hit.score!);
    assert.ok(scores.every(score => typeof score === "number"), "each relevant hit carries its score");
    assert.deepEqual(scores, [...scores].sort((a, b) => a - b), "lower scores come first");
    const newestAsk = pageAsk("newest", 20, null);
    assert.equal(mergePages([searchPrime(db, "us-metal02", parseQuery({ q: "relay" }), newestAsk, null)], newestAsk).hits[0]!.score, undefined, "newest hits carry no score");
  });

  test(`${label}: filters cut the hits and the exact total alike`, () => {
    assert.equal(newest("relay is:error").total, 1);
    assert.equal(newest("relay from:owner").total, 1);
    assert.equal(newest("relay from:tool").total, 2);
    assert.equal(newest("relay from:parent").total, 1);
    assert.equal(newest('relay in:"relay timeout"').total, 2, "a chat name covers its subagents");
    assert.equal(newest(`relay in:${JOB.slice(0, 8)}`).total, 2);
    assert.equal(newest("relay -probe").total, 4);
    assert.equal(newest("relay kind:message").total, 3);
    assert.equal(newest(`relay after:2026-10-20`).total, 0);
    assert.equal(searchPrime(db, "us-metal02", parseQuery({ q: "relay", since: "2026-10-20T00:03:00Z" }), pageAsk("newest", 20, null), null).total, 3);
    assert.equal(newest("from:owner").total, 1, "filters alone search without text");
    assert.equal(newest("").total, 0);
  });

  test(`${label}: a session id finds the text that names it and that session's own messages`, () => {
    const page = newest(CHAT.slice(0, 8));
    assert.deepEqual(page.hits.map(item => item.hit.at).sort(), [min(1), min(6)]);
    assert.equal(page.total, 2);
    assert.equal(newest(`${CHAT.slice(0, 8)} relay`).total, 1);
    const job = (ask: ReturnType<typeof pageAsk>) => mergePages([searchPrime(db, "us-metal02", parseQuery({ q: JOB.slice(0, 8) }), ask, null)], ask);
    const ats: number[] = [];
    let ask = pageAsk("newest", 1, null);
    for (;;) {
      const merged = job(ask);
      ats.push(...merged.hits.map(hit => hit.at));
      if (!merged.next) break;
      ask = pageAsk("newest", 1, merged.next);
    }
    assert.deepEqual(ats, [min(6), min(2)], "a session's own messages page newest first through its file");
  });

  test(`${label}: family roots limit hits to the chat tree`, () => {
    assert.equal(newest("relay", [CHAT, JOB]).total, 3);
    assert.equal(newest("relay", [OTHER]).total, 2);
  });

  test(`${label}: a cursor pages newest hits with no gap and no repeat`, () => {
    const seen: number[] = [];
    let ask = pageAsk("newest", 2, null);
    for (;;) {
      const merged = mergePages([searchPrime(db, "us-metal02", parseQuery({ q: "relay" }), ask, null)], ask);
      seen.push(...merged.hits.map(hit => hit.at));
      if (!merged.next) break;
      ask = pageAsk("newest", 2, merged.next);
    }
    assert.deepEqual(seen, [min(5), min(4), min(3), min(2), min(1)]);
  });

  test(`${label}: durable thread hits merge with prime hits and count in the total`, () => {
    const durable = makeDurable(join(dir, `durable-${ftsKind}-${docsMeta}.sqlite`), [{ id: "thread-a", name: "durable thread" }], [
      { thread: "thread-a", kind: "pi.user", author: "owner", at: min(10), text: "relay is back" },
      { thread: "thread-a", kind: "pi.assistant", author: "durable thread", at: min(11), text: "nothing here" },
    ]);
    const query = parseQuery({ q: "relay" });
    const ask = pageAsk("newest", 3, null);
    const merged = mergePages([searchPrime(db, "us-metal02", query, ask, null), searchDurable(durable, 0, "us-metal02", query, ask, null)], ask);
    assert.equal(merged.total, 6);
    assert.deepEqual(merged.hits.map(hit => hit.source), ["durable", "prime", "prime"]);
    const hit = merged.hits[0]!;
    assert.deepEqual([hit.session, hit.root, hit.thread, hit.kind], ["thread-a", "thread-a", "durable thread", "user"]);
    const ref = parseRef(hit.ref);
    assert.equal(ref.source, "durable");
    const read = readDurable(durable, "us-metal02", ref as Extract<typeof ref, { source: "durable" }>, 3, 3, null);
    assert.deepEqual(read.messages.map(message => [message.kind, message.text]), [["user", "relay is back"], ["assistant", "nothing here"]]);
    assert.equal(searchDurable(durable, 0, "us-metal02", query, ask, ["other"]).total, 0);
    durable.close();
  });

  test(`${label}: read returns the messages around a hit and refuses one outside the family`, () => {
    const ref = parseRef(`us-metal02:${SUB}@${min(3)}#${min(3) * 1024}`);
    assert.equal(ref.source, "prime");
    const answer = readPrime(db, "us-metal02", ref as Extract<typeof ref, { source: "prime" }>, 3, 3, null);
    assert.equal(answer.thread, "relay probe");
    assert.deepEqual(answer.messages.map(message => message.text), ["the relay probe answered fine"]);
    const job = parseRef(`us-metal02:${JOB}@${min(6)}#${min(6) * 1024}`) as Extract<ReturnType<typeof parseRef>, { source: "prime" }>;
    assert.deepEqual(readPrime(db, "us-metal02", job, 3, 3, null).messages.map(message => message.at), [min(2), min(6)]);
    assert.throws(() => readPrime(db, "us-metal02", job, 3, 3, [OTHER]), /outside/);
    assert.throws(() => parseRef("nope"), /Not a hit ref/);
  });
}
