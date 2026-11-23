/**
 * `scripts/duties/agent-memory.ts`:
 * 1. A recall session's turn counts as answered only once it is not live and holds an answer, a stop or an error. On 11-20 a fresh test
 *    thread read as an empty, not-live turn while its run worked, and the precheck graded 4 of 7 sessions as "(nothing)" though each
 *    answered moments later.
 * 2. A short match word is a whole word: seo's "no" matched inside "now".
 * 3. A title that opens with "wip" is session state only as a label, not in a lasting entry about the wip reaction.
 * 4. Every recall agent is archived and its folder deleted, on an error or a timeout too, and a sweep cleans what a killed run left: on
 *    11-20 seven recall agents stayed unarchived.
 * 5. A call rides out a chat server restart: on 11-22 two apps/chat releases ended a d3 rerun with ECONNREFUSED.
 * 6. A recall poll that fails is read again: on 11-22 a pi-host restart ended 5 of 10 recalls with a 500 "pi-host is shutting down".
 * 7. A recall whose wait ran out got no model answer and is not measured, where a turn that ended wrong or empty still counts wrong: on
 *    11-23 all 12 sessions waited 1,200 s on the account pool and the run stored recall 0 of 31.
 * 8. The name of an env variable after "secret =" says where a value lives and is no secret written out.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { call, EMPTY_TURN, emptyTurn, finishedReply, holds, lastMeasuredRecall, recall, recallCount, scratchReason, secretReason, splitAnswers, sweepRecallAgents, unanswered } from "../../scripts/duties/agent-memory.ts";

const ask = { kind: "message", text: "Quick questions" };

test("an empty turn that reads not live is still running", () => {
  assert.equal(finishedReply([ask, { kind: "turn", live: false, text: "", usage: { cost: 0 } }]), null);
  assert.equal(finishedReply([ask, { kind: "turn", live: false, text: "", sent: [], usage: { cost: 0 } }]), null);
});

test("a live turn is running even with text", () => {
  assert.equal(finishedReply([ask, { kind: "turn", live: true, text: "1. No." }]), null);
  assert.equal(finishedReply([ask]), null);
});

test("a finished turn gives its text, its sent posts and its cost", () => {
  const done = finishedReply([ask, { kind: "turn", live: false, text: "1. No.\n2. Yes.", usage: { cost: 0.36 } }]);
  assert.deepEqual(done, { reply: "1. No.\n2. Yes.", cost: 0.36 });
  assert.deepEqual(splitAnswers(done!.reply, 2).map(answer => answer.trim()), ["No.", "Yes."]);
  const spoken = finishedReply([ask, { kind: "turn", live: false, text: "1. No.", sent: ["1. No.", "2. Yes."] }]);
  assert.equal(spoken?.reply, "1. No.\n2. Yes.");
});

test("a turn that failed with no answer ends with its error", () => {
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "", error: "The model call failed.", stop: "error" }]), { reply: "", error: "The model call failed." });
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "", stop: "aborted" }]), { reply: "", error: "turn aborted" });
});

test("a turn whose run sleeps on a pool slot or works is not over, even on the slot's retry error", () => {
  const slotOpen = { kind: "turn", live: false, text: "", stop: "error", error: "pi-pool: the account slot is open; the service is temporarily unavailable until the retry sends the request" };
  assert.equal(finishedReply([ask, slotOpen], "sleeping"), null);
  assert.equal(finishedReply([ask, slotOpen], "working"), null);
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "1. No." }], "idle"), { reply: "1. No." });
});

test("a turn that answered before it stopped keeps its answer", () => {
  assert.deepEqual(finishedReply([ask, { kind: "turn", live: false, text: "1. No.", stop: "aborted" }]), { reply: "1. No." });
});

test("a short match word is a whole word, a longer one may run on", () => {
  assert.equal(holds("Not now, the launch is later.", ["no", "launch"]), false);
  assert.equal(holds("No, wait for the proper launch.", ["no", "launch"]), true);
  assert.equal(holds("It manages orgs and plans.", ["org"]), false);
  assert.equal(holds("It manages orgs and plans.", ["org|orgs"]), true);
  assert.equal(holds("Revoking one revokes the other.", ["revok", "both|the other"]), true);
  assert.equal(holds("Prevent the event.", ["vent"]), false);
  assert.equal(holds("Only virev.ai/mcp/insight has it.", ["/mcp/insight"]), true);
});

const entry = (title: string, content = "A lasting fact.") => ({ id: "e", kind: "memory", title, content });

test("a wip title is session state only as a label or with a plan step", () => {
  assert.equal(scratchReason(entry("WIP and done reactions are prompt-level, not server code")), null);
  assert.equal(scratchReason(entry("Reactions (wip 👀, done ✅) are prompt-level")), null);
  assert.equal(scratchReason(entry("Status codes the relay returns")), null);
  assert.equal(scratchReason(entry("WIP: cache fix half done")), "title reads as session state");
  assert.equal(scratchReason(entry("wip p12 cache fix")), "title reads as session state");
  assert.equal(scratchReason(entry("Status")), "title reads as session state");
  assert.equal(scratchReason(entry("Session state: install cleanup, p14 fixes")), "title reads as session state");
});

test("a key written out is a secret unless ideal.json lists it as a committed public value", () => {
  const stub = entry("Local crawler stub", "POST /__stub/faults needs header x-api-key: local-agent-key (the stub's CRAWLER_API_KEY).");
  assert.equal(secretReason(stub), "api-key written out");
  assert.equal(secretReason(stub, new Set(["local-agent-key"])), null);
  assert.equal(secretReason(entry("Stub key", "api_key=local-agent-key.")), "api_key written out");
  assert.equal(secretReason(entry("Stub key", "api_key=local-agent-key."), new Set(["local-agent-key"])), null);
  assert.equal(secretReason(entry("Prod key", "api_key: prod-9f3a2c71e0"), new Set(["local-agent-key"])), "api_key written out");
});

test("an env variable's name after a secret word is where the value lives, not a secret", () => {
  assert.equal(secretReason(entry("Staging sign-in", "Mint a ticket (x-agent-secret = STAGING_AGENT_SECRET in apps/search/.env.staging, read the ticket).")), null);
  assert.equal(secretReason(entry("Call shape", "header X-API-Key = CRAWLER_API_KEY, read with `npx dotenvx get CRAWLER_API_KEY -f .env.staging`")), null);
  assert.equal(secretReason(entry("Call shape", "api_key: CRAWLER_API_KEY.")), null);
  assert.equal(secretReason(entry("Prod key", "secret = PROD9F3A2C71E0")), "secret written out");
  assert.equal(secretReason(entry("Prod key", "secret = Prod_9f3a_2c71")), "secret written out");
});

test("a recall whose wait ran out is not measured, and a turn that ended wrong, empty or failed still counts", () => {
  const right = { graded: [{ right: true }, { right: true }, { right: false }] };
  const waited = { error: "no answer within 1200 s", unanswered: true, graded: [{ right: false }, { right: false }, { right: false }] };
  const old = { error: "no answer within 1200 s, last poll 500", graded: [{ right: false }] };
  const empty = { error: `${EMPTY_TURN}: the turn ended with no text`, graded: [{ right: false }, { right: false }] };
  const failed = { error: "The model call failed.", graded: [{ right: false }] };
  assert.equal(unanswered(waited), true);
  assert.equal(unanswered(old), true);
  assert.equal(unanswered(empty), false);
  assert.equal(unanswered(failed), false);
  assert.deepEqual(recallCount([right, waited, old, empty, failed]), { asked: 6, right: 2, unmeasured: 2 });
  assert.deepEqual(recallCount([waited, old]), { asked: 0, right: 0, unmeasured: 2 });
  assert.deepEqual(recallCount([]), { asked: 0, right: 0, unmeasured: 0 });
});

test("a run where no session answered keeps the recall share of the newest run that measured one", () => {
  const waited = { error: "no answer within 1200 s", graded: [{ right: false }] };
  const details: Record<string, unknown> = {
    "none.json": { agents: [{ recall: waited }, { recall: waited }, {}] },
    "part.json": { agents: [{ recall: waited }, { recall: { graded: [{ right: true }, { right: true }, { right: false }] } }] },
    "all.json": { agents: [{ recall: { graded: [{ right: true }] } }] },
    "no-recall.json": { agents: [{}] },
  };
  const read = (file: string): unknown => {
    if (!(file in details)) throw new Error(`ENOENT ${file}`);
    return details[file];
  };
  const runs = [{ at: 1, detail: "all.json" }, { at: 5, detail: "none.json" }, { at: 3, detail: "part.json" }, { at: 4, detail: "gone.json" }, { at: 6, detail: "no-recall.json" }, { at: 7 }];
  assert.deepEqual(lastMeasuredRecall(runs, read), { pct: 66.7, at: 3 });
  assert.deepEqual(lastMeasuredRecall([{ at: 5, detail: "none.json" }], read), null);
  assert.deepEqual(lastMeasuredRecall([], read), null);
});

/** A stub of :5184 for recall agents: `send` and `items` act as each test sets, and every call is logged. */
function stub(opts: { send?: number; itemsStatus?: () => number; items?: () => unknown[]; status?: () => string; agents?: { id: string; name: string; thread: string; archived?: boolean; createdAt?: number }[] }) {
  const calls: string[] = [];
  const agents = opts.agents ?? [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push(`${req.method} ${req.url}`);
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method === "POST" && req.url === "/api/agents") {
      const name = (JSON.parse(body) as { name: string }).name;
      const made = { id: `ag_${name.replace(/ /g, "-")}`, name, thread: `t-${agents.length}`, createdAt: Date.now() };
      agents.push(made);
      return reply(200, made);
    }
    if (req.method === "GET" && req.url === "/api/agents?test=1") return reply(200, agents);
    if (req.method === "POST" && req.url?.endsWith("/send")) return reply(opts.send ?? 200, {});
    if (req.method === "GET" && req.url?.endsWith("/items")) {
      const status = opts.itemsStatus?.() ?? 200;
      return reply(status, status === 200 ? { items: opts.items?.() ?? [] } : { error: "pi-host is shutting down" });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/c/")) return reply(200, { summary: { status: opts.status?.() ?? "idle" } });
    if (req.method === "PATCH") {
      const agent = agents.find(a => `/api/c/${a.thread}` === req.url);
      if (agent) agent.archived = true;
      return reply(200, {});
    }
    reply(404, {});
  });
  return new Promise<{ url: string; calls: string[]; agents: typeof agents; close: () => void }>(done => server.listen(0, "127.0.0.1", () => {
    done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, agents, close: () => server.close() });
  }));
}

const root = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const record = { id: "ag_seo", slug: "seo", name: "seo", workThread: "w" };
const questions = [{ q: "May you post?", match: ["no"] }];

for (const [label, opts, error] of [
  ["a send that fails", { send: 500 }, /send: 500/],
  ["a turn that never ends", { items: () => [{ kind: "turn", live: true }] }, /no answer within 0 s/],
] as const) {
  test(`the recall agent is archived and its folder deleted after ${label}`, async () => {
    const agentsDir = mkdtempSync(join(root, "agents-"));
    const server = await stub(opts);
    try {
      const result = await recall(server.url, agentsDir, record, questions, "s1", { waitMs: 50, pollMs: 10 });
      assert.match(result.error ?? "", error);
      assert.equal(result.unanswered, label === "a turn that never ends" ? true : undefined);
      assert.equal(server.agents.length, 1);
      assert.equal(server.agents[0]!.archived, true);
      assert.equal(existsSync(join(agentsDir, "memory-recall-seo-s1")), false);
    } finally {
      server.close();
    }
  });
}

test("a recall waits past the pool slot's retry error for the answer", async () => {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  let polls = 0;
  const slotOpen = { kind: "turn", live: false, text: "", stop: "error", error: "pi-pool: the account slot is open; the service is temporarily unavailable until the retry sends the request" };
  const server = await stub({
    items: () => (++polls < 3 ? [slotOpen] : [{ kind: "turn", live: false, text: "1. No." }]),
    status: () => (polls < 3 ? "sleeping" : "idle"),
  });
  try {
    const result = await recall(server.url, agentsDir, record, questions, "s1", { waitMs: 5000, pollMs: 10 });
    assert.equal(result.error, undefined);
    assert.equal(result.reply, "1. No.");
  } finally {
    server.close();
  }
});

test("an idle thread's turn with no text, post, stop or error reads empty; one that works or answers does not", () => {
  assert.equal(emptyTurn([ask, { kind: "turn", live: false, text: "", sent: [] }], "idle"), true);
  assert.equal(emptyTurn([ask, { kind: "turn", live: false, text: "" }], "working"), false);
  assert.equal(emptyTurn([ask, { kind: "turn", live: true, text: "" }], "idle"), false);
  assert.equal(emptyTurn([ask, { kind: "turn", live: false, text: "", sent: ["1. No."] }], "idle"), false);
  assert.equal(emptyTurn([ask], "idle"), false);
});

test("a recall whose turn stays over and empty ends with the empty turn error, not the full wait", async () => {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  const server = await stub({ items: () => [{ kind: "turn", live: false, text: "", sent: [], usage: { cost: 0.02 } }] });
  try {
    const result = await recall(server.url, agentsDir, record, questions, "s1", { waitMs: 60_000, pollMs: 10, settleMs: 50 });
    assert.match(result.error ?? "", new RegExp(`^${EMPTY_TURN}:`));
    assert.ok(result.seconds < 5);
  } finally {
    server.close();
  }
});

test("a recall waits past a short empty read for the answer that lands after it", async () => {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  let polls = 0;
  const server = await stub({ items: () => [{ kind: "turn", live: false, text: ++polls < 4 ? "" : "1. No." }] });
  try {
    const result = await recall(server.url, agentsDir, record, questions, "s1", { waitMs: 5000, pollMs: 10, settleMs: 1000 });
    assert.equal(result.error, undefined);
    assert.equal(result.reply, "1. No.");
  } finally {
    server.close();
  }
});

test("a recall reads past a poll that fails while pi-host restarts", async () => {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  let polls = 0;
  const server = await stub({
    itemsStatus: () => (++polls < 3 ? 500 : 200),
    items: () => [{ kind: "turn", live: false, text: "1. No." }],
  });
  try {
    const result = await recall(server.url, agentsDir, record, questions, "s1", { waitMs: 5000, pollMs: 10 });
    assert.equal(result.error, undefined);
    assert.equal(result.reply, "1. No.");
    assert.ok(polls >= 3);
  } finally {
    server.close();
  }
});

test("the sweep cleans this run's and a dead run's recall agents and keeps a live run's", async () => {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  const now = Date.now();
  const agents: { id: string; name: string; thread: string; createdAt: number; archived?: boolean }[] = [
    { id: "ag_memory-recall-seo-s1", name: "memory recall seo s1", thread: "a", createdAt: now },
    { id: "ag_memory-recall-mcp-old", name: "memory recall mcp old", thread: "b", createdAt: now - 3_600_000 },
    { id: "ag_memory-recall-vent-s2", name: "memory recall vent s2", thread: "c", createdAt: now },
    { id: "ag_blind-walk", name: "blind walk", thread: "d", createdAt: now - 3_600_000 },
  ];
  for (const name of ["memory-recall-seo-s1", "memory-recall-vent-s2", "memory-recall-gone-x", "blind-walk"]) mkdirSync(join(agentsDir, name));
  const server = await stub({ agents });
  try {
    const { swept, left } = await sweepRecallAgents(server.url, agentsDir, { stamp: "s1", now });
    assert.deepEqual(left, []);
    assert.deepEqual(swept.sort(), ["ag_memory-recall-gone-x", "ag_memory-recall-mcp-old", "ag_memory-recall-seo-s1"]);
    assert.deepEqual(agents.map(a => a.archived ?? false), [true, true, false, false]);
    assert.equal(existsSync(join(agentsDir, "memory-recall-vent-s2")), true);
    assert.equal(existsSync(join(agentsDir, "blind-walk")), true);
    assert.equal(existsSync(join(agentsDir, "memory-recall-seo-s1")), false);
  } finally {
    server.close();
  }
});

test("a call waits for a chat server that restarts, and an HTTP error still throws", async () => {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const late = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(req.url === "/bad" ? 500 : 200, { "content-type": "application/json" });
    res.end(req.url === "/bad" ? "{\"error\":\"boom\"}" : "{\"ok\":true}");
  });
  const timer = setTimeout(() => late.listen(port, "127.0.0.1"), 1500);
  try {
    assert.deepEqual(await call(`http://127.0.0.1:${port}`, "GET", "/ok", undefined, 20_000), { ok: true });
    await assert.rejects(call(`http://127.0.0.1:${port}`, "GET", "/bad", undefined, 20_000), /500/);
  } finally {
    clearTimeout(timer);
    await new Promise<void>(done => late.close(() => done()));
  }
  await assert.rejects(call(`http://127.0.0.1:${port}`, "GET", "/ok", undefined, 0));
});
