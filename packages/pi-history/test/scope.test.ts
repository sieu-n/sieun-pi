import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactRoot, callerRoot, chatOf, familyRoots, localRoots, readSettings, RegistryReader, type Registry } from "../src/core/scope.ts";
import { makeIndex } from "./fixture.ts";

const id = (n: number): string => `01a10000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const CHAT = id(1), JOB = id(2), NAMED = id(3), GRANDJOB = id(4), OTHER = id(5), SUB = id(6);
const registry: Registry = { jobs: {
  [JOB]: { chat: "frontend bro", chatId: CHAT },
  "relay probe job": { chat: "frontend bro" },
  [GRANDJOB]: { chatId: JOB },
  "other chat job": { chat: "crawler VP", chatId: OTHER },
} };
const names = new Map<string, string | null>([[CHAT, "frontend bro"], [JOB, "relay timeout"], [NAMED, "relay probe job"], [GRANDJOB, null], [OTHER, "crawler VP"]]);
const nameOf = (root: string): string | null => names.get(root) ?? null;

test("chat_of follows the registry by id and by name, through a job's own root jobs", () => {
  assert.equal(chatOf(JOB, registry, nameOf), CHAT);
  assert.equal(chatOf(NAMED, registry, nameOf), CHAT, "a job keyed by name finds its chat through the chat name's id");
  assert.equal(chatOf(GRANDJOB, registry, nameOf), CHAT);
  assert.equal(chatOf(CHAT, registry, nameOf), CHAT);
  assert.equal(chatOf(OTHER, registry, nameOf), OTHER);
});

test("the family is the chat, its root jobs by id or name, and their own jobs", () => {
  assert.deepEqual(new Set(familyRoots([CHAT], registry, names)), new Set([CHAT, JOB, NAMED, GRANDJOB]));
  assert.deepEqual(familyRoots([OTHER], registry, names), [OTHER]);
});

test("the caller's root comes from the index, else from the artifact folder in its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-scope-"));
  const db = makeIndex(join(dir, "h.db"), [{ session: CHAT, name: "frontend bro" }, { session: SUB, root: JOB, parent: JOB, depth: 1 }, { session: JOB, name: "relay timeout" }], []);
  assert.equal(callerRoot(db, SUB, null), JOB);
  const path = `/home/x/.prime/agent/session-artifacts/${JOB}/sub-1/sub-2/${id(9)}.jsonl`;
  assert.equal(artifactRoot(path), JOB);
  assert.equal(callerRoot(db, id(9), path), JOB);
  assert.equal(callerRoot(db, id(10), `/home/x/.prime/agent/sessions/x/${id(10)}.jsonl`), id(10));
  assert.deepEqual(localRoots(db), new Map([[CHAT, "frontend bro"], [JOB, "relay timeout"]]));
  db.close();
});

test("settings default to scope all and the durable index, and change when the file does", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-settings-"));
  const file = join(dir, "settings.json");
  const first = readSettings(file);
  assert.equal(first.agentScope, "all");
  assert.match(first.durableIndexes[0]!, /\.prime\/agent\/pi-host\/durable\/index\.sqlite$/);
  writeFileSync(file, JSON.stringify({ agentScope: "family", box: "mac", durableIndexes: [] }));
  const second = readSettings(file);
  assert.deepEqual([second.agentScope, second.box, second.durableIndexes], ["family", "mac", []]);
});

test("a remote registry is fetched on each read and the last copy stands when the chat host is down", async () => {
  let up = true;
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    if (!up) throw new Error("down");
    return new Response(JSON.stringify({ jobs: { [JOB]: { chatId: CHAT } } }));
  }) as typeof fetch;
  const reader = new RegistryReader(() => ({ kind: "remote", url: "http://chat/cap/api/agent/jobs" }), fetcher);
  assert.equal((await reader.read()).jobs[JOB]?.chatId, CHAT);
  up = false;
  assert.equal((await reader.read()).jobs[JOB]?.chatId, CHAT);
  assert.equal(calls, 2);
});
