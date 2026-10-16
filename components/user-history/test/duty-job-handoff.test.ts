import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { jobRegistry } from "../src/chat-sources.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";

test("a job whose run the queue admitted marks its first turn before its brief goes, and a job with no admission does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-handoff-"));
  const calls: string[] = [];
  let next = 0;
  const jobs = dutyJobHost({ rows: async () => [], registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/data/boards/${id}.json`,
    archives: { async add() {} }, started: async id => { calls.push(`low ${id}`); }, handoff: async id => { calls.push(`handoff ${id}`); },
    threads: { async create() { return { id: `job-${++next}` }; }, async prompt(id) { calls.push(`brief ${id}`); } } });
  const chat = { id: CHAT, name: "Crawler VP", cwd: "/repo", board: "/data/boards/x.json" };
  await jobs.start(chat, "geonode proxy use Crawler VP 00:05", "brief", true);
  await jobs.start(chat, "geonode proxy use Crawler VP 00:10", "brief");
  assert.deepEqual(calls, ["low job-1", "handoff job-1", "brief job-1", "low job-2", "brief job-2"]);
});
