/**
 * `scripts/duties/agent-memory.ts`:
 * 1. A recall session's turn counts as answered only once it is not live and holds an answer, a stop or an error. On 11-20 a fresh test
 *    thread read as an empty, not-live turn while its run worked, and the precheck graded 4 of 7 sessions as "(nothing)" though each
 *    answered moments later.
 * 2. A short match word is a whole word: seo's "no" matched inside "now".
 * 3. A title that opens with "wip" is session state only as a label, not in a lasting entry about the wip reaction.
 * 4. Every recall agent is archived and its folder deleted, on an error or a timeout too, and a sweep cleans what a killed run left: on
 *    11-20 seven recall agents stayed unarchived.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { finishedReply, holds, recall, scratchReason, splitAnswers, sweepRecallAgents } from "../../scripts/duties/agent-memory.ts";

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

/** A stub of :5184 for recall agents: `send` and `items` act as each test sets, and every call is logged. */
function stub(opts: { send?: number; items?: () => unknown[]; agents?: { id: string; name: string; thread: string; archived?: boolean; createdAt?: number }[] }) {
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
    if (req.method === "GET" && req.url?.endsWith("/items")) return reply(200, { items: opts.items?.() ?? [] });
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
      assert.equal(server.agents.length, 1);
      assert.equal(server.agents[0]!.archived, true);
      assert.equal(existsSync(join(agentsDir, "memory-recall-seo-s1")), false);
    } finally {
      server.close();
    }
  });
}

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
