// Replays the AI harness chat's Wiki dream (d4) of 11-07. Its job "wiki dream AI harness developer environment 01:45" (01a1b6e6) started at
// 16:45Z, and pi-pool held its tree in line for an account until 23:15Z. wiki_problems read 0 from 18:29Z to 19:50Z and then 2, 5, 9 and 12 by
// 22:55Z, from commits whose sessions had each got commit.mjs's follow gate warning and kept working: ad8108976d (21:35:07Z, session 01a1b337,
// a subagent of chat 01a115e2) put the serp-api pages behind. Each push run only queued the new pages as messages to the held job. In the 7
// days to 23:11Z, 1,285 of the 1,358 counted page-hours fell while pi-pool held the dream's one job, and 188 of the 211 counted pages came
// from such warned commits (~/work/wiki-dream-held-root-cause-1108). A run that finds the job held now asks the session that made each page's
// commit, while its tree works, and the precheck names that session.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PoolHold } from "../src/chat-pool.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties, IN_POOL_LINE } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { treeFilesOf } from "../src/send-once.ts";
import { type Duty, type DutyCut, type DutyJobRef, type FlaggedSlice, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";
import { measureDream, pageMakers, refFile, sessionTree, type DreamDeps, type StalePage } from "../scripts/duties/wiki-dream.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a1b6e6-a5a7-7374-b8f6-41af8dff1635", name: "wiki dream AI harness developer environment 01:45" };
const STARTED = Date.parse("2026-11-07T16:45:31.431Z");
const CUT: DutyCut = { at: Date.parse("2026-11-07T16:45:33.070Z"), provider: "anthropic", slotAt: Date.parse("2026-11-07T16:50:00.000Z"),
  error: "token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at 2026-11-07T16:50:00.000Z." };
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const SERP_SESSION = "01a1b337-92f3-74b8-92d6-c77016be6b48";
const IDLE_TREE = "01a11af8-962e-773d-a19a-ee4104011987";
const SERP = "apps/crawler-v3/architecture/serp-api/index.html";
const SERP_PROJECTS = "experiments/2026-10-22-google-serp-projects/index.html";
const CONVEX = "domains/devops/convex-deployments.html";
const OWN = "domains/devops/stability-pipeline/index.html";

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 40, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
const failed = JSON.stringify({ type: "message", timestamp: "2026-11-07T22:51:03.088Z", message: { role: "assistant", content: [], stopReason: "error",
  errorMessage: "pi-pool: this session waits for its slot at 2026-11-07T23:00:00.000Z." } });
const page = (item: string, maker?: FlaggedSlice["maker"]): FlaggedSlice =>
  ({ kind: "stale_vs_code", item, excerpt: `${item} is behind its code`, handOff: true, sig: "2026-11-07T18:51:59.999Z", ...maker ? { maker } : {} });
const FLAGGED = [
  page(SERP, { commit: "ad8108976d302e68d06814bdab905c9a2db3138c", session: SERP_SESSION, tree: CRAWLER }),
  page(SERP_PROJECTS, { commit: "ad8108976d302e68d06814bdab905c9a2db3138c", session: SERP_SESSION, tree: CRAWLER }),
  page(CONVEX, { commit: "4e048e27df981438f82ad62f27a6402a5d7207d2", session: "01a1b746-5f3e-72eb-a298-40673ac14357", tree: IDLE_TREE }),
  page(OWN, { commit: "b86ee8683efe9779b84da19fa5e78befe29463e9", session: "01a1b6e6-0000-7000-8000-000000000000", tree: JOB.id }),
];

async function runsAt(times: readonly string[], hold: PoolHold | null, cut: DutyCut | null = CUT, jobWorking = false) {
  const dir = await mkdtemp(join(tmpdir(), "duty-held-makers-"));
  try {
    const agentDir = join(dir, "agent");
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await writeFile(join(agentDir, "sessions", `${JOB.id}.jsonl`), failed + "\n");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(${JSON.stringify({ metrics: { wiki_problems: 12 }, flagged: FLAGGED })}));`);
    const store = new DutyStore(dir);
    await store.update(CHAT, duties => {
      duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays in sync", goal: "the wiki stays in sync",
        metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
        precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
        createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 790, lastRunAt: STARTED } satisfies Duty);
    });
    await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "push", ms: 30_000, verdict: "missed",
      metrics: { wiki_problems: { value: 28, target: 0, op: "<=", met: false } }, summary: "wiki_problems 28 (target at most 0)", job: JOB, ...cut ? { cut } : {} });
    const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, jobWorking)],
      [CRAWLER, row(CRAWLER, "Crawler VP", true)], [IDLE_TREE, row(IDLE_TREE, "Search VP", false)]]);
    const started: string[] = [];
    const steered: string[] = [];
    const messaged: { session: string; tree: string; text: string }[] = [];
    const summaries: string[] = [];
    const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
      rows: async () => [...rows.values()], schedules: async () => new Map(), treeFiles: id => treeFilesOf(id, agentDir) });
    const clock = { now: 0 };
    const duties = new Duties(store, {
      isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: () => {},
      poolHolds: async tree => tree === JOB.id ? hold : null,
      message: async (session, tree, text) => { messaged.push({ session, tree, text }); },
      jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
        retire: async job => { rows.get(job.id)!.archived = true; },
        steer: async (job, text) => { steered.push(`${job.id}: ${text}`); },
        start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
    });
    try {
      for (const at of times) {
        clock.now = Date.parse(at);
        assert.ok(await duties.runNow(CHAT, "d4"));
        await duties.settled();
        summaries.push((await store.runs(CHAT)).find(record => record.at === clock.now)!.summary);
      }
      return { summaries, started, steered, messaged };
    } finally { duties.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a run that finds the Wiki dream's job held in pi-pool's line asks the working session that made each page's commit (11-07 22:55Z)", async () => {
  const { summaries, started, steered, messaged } = await runsAt(["2026-11-07T22:55:39.000Z", "2026-11-07T23:11:17.943Z"], "line");
  assert.deepEqual(started, [], "the held job keeps its place in the line");
  assert.ok(summaries[0]!.includes(`${STILL_WORKING} (job ${JOB.name} ${IN_POOL_LINE})`), summaries[0]);
  assert.equal(messaged.length, 1, "one message to the serp session; the idle Search VP tree and the dream's own tree are not asked");
  assert.equal(messaged[0]!.session, SERP_SESSION);
  assert.equal(messaged[0]!.tree, CRAWLER);
  assert.ok(messaged[0]!.text.includes(SERP) && messaged[0]!.text.includes(SERP_PROJECTS) && messaged[0]!.text.includes("ad8108976d"), messaged[0]!.text);
  assert.ok(!messaged[0]!.text.includes(CONVEX) && !messaged[0]!.text.includes(OWN), messaged[0]!.text);
  assert.ok(summaries[0]!.includes("asked the sessions that made them to fix 2 items"), summaries[0]);
  assert.equal(steered.length, 1, "the held job still gets the run's items queued");
  assert.ok(!summaries[1]!.includes("asked the sessions"), "the next run asks nobody again for the same pages");
});

test("a run beside a working dream job asks no maker, since the job takes the pages itself", async () => {
  const { messaged, steered, started } = await runsAt(["2026-11-07T17:10:00.000Z"], null, null, true);
  assert.deepEqual(started, []);
  assert.equal(steered.length, 1);
  assert.deepEqual(messaged, []);
});

// On 11-08 pi-pool kept d4's cut jobs in no line: the 03:42Z job was cut at 03:46:31Z on credential_unavailable, the 03:58Z push run started
// another, and that one was cut at 04:05:01Z, so the runs replaced cut jobs and never found one held.
test("a run that replaces a cut dream job asks the makers too", async () => {
  const { started, messaged } = await runsAt(["2026-11-07T22:55:39.000Z"], null);
  assert.equal(started.length, 1);
  assert.equal(messaged.length, 1);
  assert.equal(messaged[0]!.session, SERP_SESSION);
  assert.ok(messaged[0]!.text.includes("was cut on a failed model call at 16:45Z"), messaged[0]!.text);
});

const STALE: StalePage[] = [
  { path: SERP, last_verified: "2026-11-07T18:52Z", verified_at: "2026-11-07T18:52:59.999Z",
    staleRefs: [{ ref: "apps/crawler-v3/src/platforms/serp/fetch.py", modified: "2026-11-07T21:35:07.000Z", since: "2026-11-07T21:35:07.000Z" }] },
  { path: SERP_PROJECTS, last_verified: "2026-11-07T18:51Z", verified_at: "2026-11-07T18:51:59.999Z",
    staleRefs: [{ ref: "apps/crawler-v3/src/platforms/serp/service.py::run_search", modified: "2026-11-07T21:35:07.000Z", since: "2026-11-07T21:35:07.000Z" }] },
  { path: CONVEX, last_verified: "2026-11-07T18:28Z", verified_at: "2026-11-07T18:28:59.999Z",
    staleRefs: [{ ref: "apps/infra/metal/compose.convex-prod.yml::convex-backend", modified: "2026-11-07T18:40:56.000Z", since: "2026-11-07T18:40:56.000Z" }] },
  { path: "domains/devops/sw-factory-threads/index.html", last_verified: "2026-11-03T14:00Z", verified_at: "2026-11-03T14:00:59.999Z",
    staleRefs: [{ ref: "sieun-pi:apps/chat/server/search.ts::missingNote", modified: "2026-11-03T14:47:00.000Z", since: "2026-11-03T14:47:00.000Z" }] },
];
const LOG = [
  `\x1e${Date.parse("2026-11-07T21:35:07Z") / 1000}\x1fad8108976d302e68d06814bdab905c9a2db3138c\x1f${SERP_SESSION}\n\napps/crawler-v3/src/platforms/serp/fetch.py\napps/crawler-v3/src/platforms/serp/service.py\n`,
  `\x1e${Date.parse("2026-11-07T18:40:56Z") / 1000}\x1f4e048e27df981438f82ad62f27a6402a5d7207d2\x1f\n\napps/infra/metal/compose.convex-prod.yml\n`,
].join("");

test("the precheck names the commit, its Session-Id and the session's tree for each page, and none for a commit with no Session-Id", async () => {
  const asked: { files: readonly string[]; since: number }[] = [];
  const makers = await pageMakers(STALE, async (files, since) => { asked.push({ files, since }); return LOG; },
    async session => session === SERP_SESSION ? CRAWLER : null);
  assert.deepEqual([...makers.keys()], [SERP, SERP_PROJECTS]);
  assert.deepEqual(makers.get(SERP_PROJECTS), { commit: "ad8108976d302e68d06814bdab905c9a2db3138c", session: SERP_SESSION, tree: CRAWLER });
  assert.equal(asked.length, 1, "one git log for every page");
  assert.deepEqual([...asked[0]!.files].sort(), ["apps/crawler-v3/src/platforms/serp/fetch.py", "apps/crawler-v3/src/platforms/serp/service.py", "apps/infra/metal/compose.convex-prod.yml"]);
  assert.equal(refFile("sieun-pi:apps/chat/server/search.ts::missingNote"), null);
  assert.equal(refFile("convex/http.ts::/api/search-admin/access"), "convex/http.ts");
  assert.equal(refFile("apps/vent/src/vent/tables.py:12-30"), "apps/vent/src/vent/tables.py");
});

test("measureDream puts the maker on the flagged page it handed off", async () => {
  const now = Date.parse("2026-11-07T22:55:39Z");
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 3, lint_failing_pages: 0 };
  const deps: DreamDeps = {
    now, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => ({ corrections: JSON.stringify({ corrections: [] }), harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }), ledger: JSON.stringify({ classes: {} }) } as Record<string, string>)[path]!,
    exec: async (file, args) => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { checkable: 3, count: 3, stale: STALE.slice(0, 3) } });
      if (args.includes("--name-only") && args.includes("--") && args.some(arg => arg.startsWith("--format=%x1e%ct%x1f%H"))) return LOG;
      return "";
    },
    treeOf: async session => session === SERP_SESSION ? CRAWLER : null,
  };
  const result = await measureDream(deps, []);
  const serp = result.flagged!.find(slice => slice.item === SERP)!;
  assert.equal(serp.handOff, true);
  assert.deepEqual(serp.maker, { commit: "ad8108976d302e68d06814bdab905c9a2db3138c", session: SERP_SESSION, tree: CRAWLER });
  assert.equal(result.flagged!.find(slice => slice.item === CONVEX)!.maker, undefined);
  assert.equal(result.metrics.source_errors, 0);
});

test("sessionTree finds a root and the root of a subagent at depth 1 or 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-tree-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", `${CRAWLER}.jsonl`), "");
    await mkdir(join(dir, "session-artifacts", CRAWLER, "sub-1", "sub-2"), { recursive: true });
    await writeFile(join(dir, "session-artifacts", CRAWLER, "sub-1", `${SERP_SESSION}.jsonl`), "");
    await writeFile(join(dir, "session-artifacts", CRAWLER, "sub-1", "sub-2", "01a1b84e-0000-7000-8000-000000000001.jsonl"), "");
    assert.equal(await sessionTree(dir, CRAWLER), CRAWLER);
    assert.equal(await sessionTree(dir, SERP_SESSION), CRAWLER);
    assert.equal(await sessionTree(dir, "01a1b84e-0000-7000-8000-000000000001"), CRAWLER);
    assert.equal(await sessionTree(dir, "01a1b84e-0000-7000-8000-00000000ffff"), null);
    assert.equal(await sessionTree(dir, "../x"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
