/**
 * search_messages (`search-messages.ts`) in the room-tools extension, against a fake chat server on loopback: the filters go to
 * `GET /api/search` with the names and meaning of the owner's Cmd K search (owner p115), and each hit prints where it sits, who wrote it,
 * its plain words, its id and its link.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { SEARCH_MESSAGES_TOOL, searchHitLine, searchQuery, type FilteredHit, type FilteredResult } from "../../src/durable/search-messages.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-search-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const AT = Date.UTC(2026, 10, 20, 6, 12);
const reply: FilteredHit = {
  id: "ch_1a2b/p90", conversation: { id: "ch_1a2b", kind: "channel", name: "sw-factory-build" }, messageId: "p90",
  author: { id: "ag_vent", name: "vent", kind: "agent" }, at: AT, kind: "post", role: "agent", threadRoot: "p85",
  where: "thread", thread: { root: "p85", title: "does search filter" }, snippet: "the index &lt;b&gt; holds <mark>kimchi</mark> &amp; more",
  link: "#/c/ch_1a2b?thread=p85&m=p90",
};
const tool: FilteredHit = {
  id: "th_9:3/e41", conversation: { id: "th_9:3", kind: "job", name: "count rows", parent: { id: "ag_vent", name: "vent" } }, messageId: "e41",
  author: { id: "ag_vent", name: "vent", kind: "agent" }, at: AT, kind: "tool", role: "tool", tool: "bash", where: "tool",
  snippet: "rows <mark>4812</mark>", link: "#/c/th_9:3?m=e41",
};

const asked: URLSearchParams[] = [];
let server: Server;
let app: ChatApp;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    asked.push(url.searchParams);
    const answer = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname !== "/api/search") return answer(404, { error: "No such route." });
    if (url.searchParams.get("in") === "#nowhere") return answer(400, { error: "No room named #nowhere." });
    const body: FilteredResult = url.searchParams.get("where") === "tool" ? { hits: [tool], total: 1 } : { hits: [reply], total: 7, nextCursor: "1" };
    return answer(200, body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function run(plan: Record<string, string | string[]>[]) {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: plan.length + 1 }, () => () => {
    const args = plan[made++];
    return args ? fauxAssistantMessage([fauxToolCall(SEARCH_MESSAGES_TOOL, args)], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(roomTools(app, "th_search"));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "th_search.sqlite")), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Find it." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("the filters go to /api/search as comma lists, with brief on and nothing for a filter left out", () => {
  const q = searchQuery({ query: "kimchi", from: ["vent", "owner"], in: "#sw-factory-build", where: ["thread", "tool"], after: "2026-11-19", before: "2026-11-21", sort: "recent", limit: 5 });
  assert.equal(q.toString(), "q=kimchi&brief=1&from=vent%2Cowner&where=thread%2Ctool&in=%23sw-factory-build&after=2026-11-19&before=2026-11-21&sort=recent&limit=5");
  assert.equal(searchQuery({ query: "x", from: "vent", where: "tool" }).toString(), "q=x&brief=1&from=vent&where=tool");
  assert.equal(searchQuery({ query: "x" }).toString(), "q=x&brief=1");
});

test("a hit line says where it sits, who wrote it, its plain words, its id and its link", () => {
  assert.equal(searchHitLine(reply), "- 2026-11-20 06:12Z #sw-factory-build, reply in thread p85 \"does search filter\" · vent: the index <b> holds kimchi & more · id ch_1a2b/p90 · #/c/ch_1a2b?thread=p85&m=p90");
  assert.equal(searchHitLine(tool), "- 2026-11-20 06:12Z job \"count rows\" of vent, tool output bash · vent: rows 4812 · id th_9:3/e41 · #/c/th_9:3?m=e41");
  assert.match(searchHitLine({ ...tool, inCall: true }), /tool call bash/);
  const { where: _w, thread: _t, link: _l, ...old } = reply;
  assert.match(searchHitLine(old), /#sw-factory-build, reply in thread p85 · vent/);
});

test("the tool returns the count, the hits and the next page, and the server's refusal as the call's error", async () => {
  const out = await run([{ query: "kimchi", from: "vent", where: ["thread"] }, { query: "4812", where: "tool" }, { query: "x", in: "#nowhere" }]);
  assert.deepEqual(asked.map(q => [q.get("from"), q.get("where"), q.get("in")]), [["vent", "thread", null], [null, "tool", null], [null, null, "#nowhere"]]);
  assert.deepEqual(out.map(r => r.isError), [false, false, true]);
  assert.match(out[0]!.text, /^1 of 7 hits\.\n- .*reply in thread p85.*\nMore: pass cursor=1\.$/);
  assert.match(out[1]!.text, /^1 of 1 hits\.\n- .*tool output bash · vent: rows 4812/);
  assert.equal(out[2]!.text, "search_messages failed: No room named #nowhere.");
});
