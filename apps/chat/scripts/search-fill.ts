/**
 * Fills meilisearch.service with every entry of pi-host's index.sqlite before a release turns search over to it, so the chat's first
 * start finds a full index and no search reads 65,000 entries in memory. It writes the cursor the chat reads, `<data dir>/search/meili.json`.
 * Run it again after the index was lost; the chat itself also fills an empty index on its own.
 *
 * Usage: node --import tsx scripts/search-fill.ts [--data-dir ~/.pi/agent/chat]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CHANNEL_COPY_LIKE } from "../server/group-rooms.ts";
import { Meili } from "../server/meili.ts";
import { likeRegex, SEARCH_DOC_VERSION, SearchEngine, SqliteEntries } from "../server/search-engine.ts";
import { readJson, writeJson } from "../server/store.ts";

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "durable-index": { type: "string" } } });
const dataDir = resolve(values["data-dir"] ?? join(homedir(), ".pi/agent/chat"));
const index = resolve(values["durable-index"] ?? join(homedir(), ".prime/agent/pi-host/durable/index.sqlite"));
const file = join(dataDir, "search", "meili.json");
const saved = readJson<{ v?: number; cursor?: string }>(file, {});
let cursor = saved.v === SEARCH_DOC_VERSION ? saved.cursor : undefined;
const started = performance.now();
const engine = new SearchEngine({
  connect: async () => new Meili(process.env.APPS_CHAT_MEILI_URL ?? "http://127.0.0.1:7700",
    readFileSync(process.env.APPS_CHAT_MEILI_KEY_FILE ?? join(homedir(), ".config/meilisearch/master.key"), "utf8").trim()),
  entries: new SqliteEntries(index), allPosts: () => [], channelCopy: likeRegex(CHANNEL_COPY_LIKE), log: line => console.log(line),
  cursor: { get: () => cursor, set: next => { cursor = next; writeJson(file, { v: SEARCH_DOC_VERSION, cursor: next }); } },
});
await engine.start();
await engine.settled();
console.log(`search index filled to rowid ${cursor} in ${((performance.now() - started) / 1000).toFixed(1)} s; cursor in ${file}`);
process.exit(0);
