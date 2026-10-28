/**
 * Project folders on the fixture host: `GET /api/projects`, a new agent in a project or the default one, the home folder refused, and
 * `PATCH /api/c/:id {cwd}` moving a root thread, which its config then shows.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/projects.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentConfig, AgentSummary, ProjectList } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start({ wordMs: 0 });
});
after(async () => {
  await s.close();
});

const work = (slug: string) => join(s.app.config.dataDir, "work", slug);
const home = () => join(s.app.config.dataDir, "home");
const cwdOf = async (thread: string) => (await s.host.threads()).find(t => t.id === thread)!.cwd;
const config = (id: string) => s.get<AgentConfig>(`/api/agents/${encodeURIComponent(id)}/config`);

test("GET /api/projects lists the configured folders on this box, the first as the default", async () => {
  const list = await s.get<ProjectList>("/api/projects");
  assert.deepEqual(list.projects, [{ path: work("harness"), name: "harness" }, { path: work("crawler"), name: "crawler" }]);
  assert.equal(list.default, work("harness"));
  assert.equal(list.home, home());
});

test("a new agent runs in the folder it names, else in the default project", async () => {
  const named = await s.send<AgentSummary>("POST", "/api/agents", { name: "crawler helper", cwd: work("crawler") });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(await cwdOf(named.body.thread), work("crawler"));

  const plain = await s.send<AgentSummary>("POST", "/api/agents", { name: "no folder named" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(await cwdOf(plain.body.thread), work("harness"));
  assert.equal((await config(plain.body.id)).runs.project, true);
});

test("the server refuses the home folder, a folder above it, a relative path and a missing folder", async () => {
  const before = (await s.host.threads()).length;
  for (const [cwd, message] of [
    [home(), /is the home folder, where no project's AGENTS\.md/],
    [dirname(home()), /is above the home folder/],
    ["work/harness", /absolute path/],
    [join(work("harness"), "missing"), /must exist on this box/],
  ] as const) {
    const refused = await s.send<{ error: string }>("POST", "/api/agents", { name: "homeless", cwd });
    assert.equal(refused.status, 400, cwd);
    assert.match(refused.body.error, message);
  }
  assert.equal((await s.host.threads()).length, before, "no thread was made");
});

test("PATCH cwd moves a root thread out of the home folder, and its config stops flagging it", async () => {
  const flagged = await config(ids.frontend);
  assert.equal(flagged.runs.cwd, home());
  assert.equal(flagged.runs.project, false);
  assert.equal(flagged.runs.canMove, true);

  const refused = await s.send<{ error: string }>("PATCH", `/api/c/${ids.frontend}`, { cwd: home() });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /home folder/);
  assert.equal(await cwdOf(ids.frontend), home());

  const moved = await s.send("PATCH", `/api/c/${ids.frontend}`, { cwd: work("crawler") });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const after = await config(ids.frontend);
  assert.equal(after.runs.cwd, work("crawler"));
  assert.equal(after.runs.project, true);
});

test("a job inside a thread follows its thread's folder, so PATCH cwd on it is refused", async () => {
  const job = (await s.host.tree(ids.vent)).find(node => node.id !== 1)!;
  const id = `${ids.vent}:${job.id}`;
  assert.equal((await config(id)).runs.canMove, false);
  const refused = await s.send<{ error: string }>("PATCH", `/api/c/${encodeURIComponent(id)}`, { cwd: work("crawler") });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /runs in its thread's folder/);
});

test("import-prime with cwd moves the thread before it copies the Prime chat's data", async () => {
  const result = await s.send("POST", `/api/threads/${ids.crawler}/import-prime`, { prime: "00000000-0000-4000-8000-0000000000aa", cwd: work("harness") });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(await cwdOf(ids.crawler), work("harness"));
});
