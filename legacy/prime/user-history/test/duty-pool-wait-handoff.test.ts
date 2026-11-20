// Replays the AI harness chat's Wiki dream (d4) of 11-18 and 11-19. From 13:04Z on 11-18 to 15:27:56Z on 11-19 pi-pool vended no account to
// any session (pi-pool.log: 0 vend events, 75,238 parked), so the 22 pages the 12:49Z to 13:20Z runs had asked the makers and the chat to fix
// counted through 99 runs: each run beside the held job "wiki dream AI harness developer environment 21:54" found them handed already and handed
// them nobody again, and the chat read the 26 h old notices only at 15:34Z. A run now hands nothing while pi-pool gives the chat no account, says
// so, and the first run after the wait hands every page that still counts again, to the maker trees at work and to the chat.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { treeFilesOf } from "../src/send-once.ts";
import { type Duty, type DutyJobRef, type FlaggedSlice, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a1f3e0-4b94-72db-beb5-0b80466fe369", name: "wiki dream AI harness developer environment 21:54" };
const STARTED = Date.parse("2026-11-19T12:54:00.000Z");
const HELD = "waits on pi-pool for its slot";
/** The first vend after the wait (pi-pool.log, 15:27:56Z on 11-19). */
const BACK = Date.parse("2026-11-19T15:27:56.000Z");

/** The 22 hand-off items of the 15:29Z run of 11-19 (d4-261120-0029.json), excerpts cut. */
const FLAGGED: FlaggedSlice[] = [
  {"kind": "stale_vs_code", "item": "apps/search/monitor-data-model-crawl.html", "excerpt": "checked 2026-11-18T07:37Z (last_verified 2026-11-18T07:37Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-18T07:37:59.999Z", "maker": {"commit": "6c59093887e34b4ea922c67e5e7f3fba01bf045c", "session": "01a1ec16-2898-724b-80ab-f94610c27c67", "tree": "01a189ec-6a9c-777d-915e-705288c02005"}},
  {"kind": "stale_vs_code", "item": "apps/search/brand-tracking-scheduling.html", "excerpt": "checked 2026-11-18T01:03Z (last_verified 2026-11-18T01:03Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-18T01:03:59.999Z", "maker": {"commit": "6c59093887e34b4ea922c67e5e7f3fba01bf045c", "session": "01a1ec16-2898-724b-80ab-f94610c27c67", "tree": "01a189ec-6a9c-777d-915e-705288c02005"}},
  {"kind": "stale_vs_code", "item": "domains/architecture/brand-watch-async-flow/scheduler.html", "excerpt": "checked 2026-11-18T01:12Z (last_verified 2026-11-18T01:12Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-18T01:12:59.999Z", "maker": {"commit": "6c59093887e34b4ea922c67e5e7f3fba01bf045c", "session": "01a1ec16-2898-724b-80ab-f94610c27c67", "tree": "01a189ec-6a9c-777d-915e-705288c02005"}},
  {"kind": "stale_vs_code", "item": "apps/crawler-v3/architecture/instagram-authed-engage/tagged-lane-claims.html", "excerpt": "checked 2026-11-17T19:25Z (last_verified 2026-11-17T19:25Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-17T19:25:59.999Z", "maker": {"commit": "6c59093887e34b4ea922c67e5e7f3fba01bf045c", "session": "01a1ec16-2898-724b-80ab-f94610c27c67", "tree": "01a189ec-6a9c-777d-915e-705288c02005"}},
  {"kind": "stale_vs_code", "item": "apps/search/enterprise-mock.html", "excerpt": "checked 2026-11-18T08:45Z (last_verified 2026-11-18T08:45Z); code changed since: apps/sear", "handOff": true, "sig": "2026-11-18T08:45:59.999Z", "maker": {"commit": "c09bab615e920a364f6f47cc3c546455776e3b99", "session": "01a1e94d-0b29-73e8-96b0-de6470f059c9", "tree": "01a189ec-9db2-754e-9028-07c0a8c5a789"}},
  {"kind": "stale_vs_code", "item": "domains/architecture/ci-deploy/runners.html", "excerpt": "checked 2026-11-18T08:47Z (last_verified 2026-11-18T08:47Z); code changed since: .github/w", "handOff": true, "sig": "2026-11-18T08:47:59.999Z", "maker": {"commit": "5bc7a6dd1e14914b20480b35b870213ac096ad4e", "session": "01a1ecae-dac2-7148-bcb3-6ad9452aed50", "tree": "01a1180e-6567-747f-bf44-452520ebdd1b"}},
  {"kind": "stale_vs_code", "item": "domains/devops/ci-cd-pipeline.html", "excerpt": "checked 2026-11-17T20:11Z (last_verified 2026-11-17T20:11Z); code changed since: .github/w", "handOff": true, "sig": "2026-11-17T20:11:59.999Z", "maker": {"commit": "5bc7a6dd1e14914b20480b35b870213ac096ad4e", "session": "01a1ecae-dac2-7148-bcb3-6ad9452aed50", "tree": "01a1180e-6567-747f-bf44-452520ebdd1b"}},
  {"kind": "stale_vs_code", "item": "projects/contact-engine-cascade/index.html", "excerpt": "checked 2026-11-18T08:45Z (last_verified 2026-11-18T08:45Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-18T08:45:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "experiments/2026-08-19-email-finder-round4/index.html", "excerpt": "checked 2026-11-18T08:46Z (last_verified 2026-11-18T08:46Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-18T08:46:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "apps/crawler-v3/adding-a-platform/contact-discovery.html", "excerpt": "checked 2026-11-18T02:25Z (last_verified 2026-11-18T02:25Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-18T02:25:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "apps/crawler-v3/contact-discovery/index.html", "excerpt": "checked 2026-11-17T15:20Z (last_verified 2026-11-17T15:20Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-17T15:20:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "experiments/email-finder/platform-reveal-mechanisms.html", "excerpt": "checked 2026-11-17T12:03Z (last_verified 2026-11-17T12:03Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-17T12:03:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "apps/crawler-v3/architecture/email-verification/index.html", "excerpt": "checked 2026-11-17T06:43Z (last_verified 2026-11-17T06:43Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-17T06:43:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "experiments/2026-07-24-contact-benchmark-v2/report.html", "excerpt": "checked 2026-11-15T19:13Z (last_verified 2026-11-15T19:13Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-15T19:13:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "projects/contact-engine-cascade/escalation-method.html", "excerpt": "checked 2026-11-15T09:50Z (last_verified 2026-11-15T09:50Z); code changed since: apps/craw", "handOff": true, "sig": "2026-11-15T09:50:59.999Z", "maker": {"commit": "ce75855935cc0360a6ed882771c3a78e6fa1e3ed", "session": "01a1edd8-783c-70ad-bcac-843c70805737", "tree": "01a189ec-3df2-76ae-a6e8-a795fda4a12f"}},
  {"kind": "stale_vs_code", "item": "apps/llm-wiki/index.html", "excerpt": "checked 2026-11-17T02:13Z (last_verified 2026-11-17T02:13Z); code changed since: sieun-pi:", "handOff": true, "sig": "2026-11-17T02:13:59.999Z"},
  {"kind": "stale_vs_code", "item": "domains/devops/stability-pipeline/push-ci/probes.html", "excerpt": "checked 2026-11-18T08:47Z (last_verified 2026-11-18T08:47Z); code changed since: .github/w", "handOff": true, "sig": "2026-11-18T08:47:59.999Z", "maker": {"commit": "5589c1e323c3b0edacfa40fd75d4bbe96706a66a", "session": "01a1d512-e765-7687-b62d-a98e2db30aba", "tree": "01a11af8-962e-773d-a19a-ee4104011987"}},
  {"kind": "stale_vs_code", "item": "domains/devops/ci-time/changes-since-10-19-runners.html", "excerpt": "checked 2026-11-18T08:46Z (last_verified 2026-11-18T08:46Z); code changed since: .github/w", "handOff": true, "sig": "2026-11-18T08:46:59.999Z", "maker": {"commit": "5589c1e323c3b0edacfa40fd75d4bbe96706a66a", "session": "01a1d512-e765-7687-b62d-a98e2db30aba", "tree": "01a11af8-962e-773d-a19a-ee4104011987"}},
  {"kind": "stale_vs_code", "item": "apps/search/campaigns/counts.html", "excerpt": "checked 2026-11-18T08:06Z (last_verified 2026-11-18T08:06Z); code changed since: convex/se", "handOff": true, "sig": "2026-11-18T08:06:59.999Z", "maker": {"commit": "b1452e7e906355b874919c7520b66d135973d5f1", "session": "01a1ec13-6955-710a-be73-80781a22b691", "tree": "01a15c6c-8bec-71fe-b7d3-1fac79a315c9"}},
  {"kind": "stale_vs_code", "item": "apps/search/brand-tracking-ui.html", "excerpt": "checked 2026-11-18T08:50Z (last_verified 2026-11-18T08:50Z); code changed since: convex/se", "handOff": true, "sig": "2026-11-18T08:50:59.999Z", "maker": {"commit": "4bf37a8e43fe4963ff6e2d122bb4a8e5335fe51d", "session": "01a1eea2-1f77-74da-8224-0379e7f360c7", "tree": "01a11af8-962e-773d-a19a-ee4104011987"}},
  {"kind": "stale_vs_code", "item": "apps/search/brand-tracking-watches.html", "excerpt": "checked 2026-11-18T03:16Z (last_verified 2026-11-18T03:16Z); code changed since: convex/se", "handOff": true, "sig": "2026-11-18T03:16:59.999Z", "maker": {"commit": "4bf37a8e43fe4963ff6e2d122bb4a8e5335fe51d", "session": "01a1eea2-1f77-74da-8224-0379e7f360c7", "tree": "01a11af8-962e-773d-a19a-ee4104011987"}},
  {"kind": "stale_vs_code", "item": "apps/search/onboarding-welcome.html", "excerpt": "checked 2026-11-18T00:43Z (last_verified 2026-11-18T00:43Z); code changed since: apps/sear", "handOff": true, "sig": "2026-11-18T00:43:59.999Z", "maker": {"commit": "4bf37a8e43fe4963ff6e2d122bb4a8e5335fe51d", "session": "01a1eea2-1f77-74da-8224-0379e7f360c7", "tree": "01a11af8-962e-773d-a19a-ee4104011987"}},
];
const key = (slice: FlaggedSlice) => `${slice.kind}|${slice.item}|${slice.sig}`;
const MADE = FLAGGED.filter(slice => slice.maker);
const MAKER_TREES = [...new Set(MADE.map(slice => slice.maker!.tree))];

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 40, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);

async function runsAt(times: readonly string[], freeAt: ((now: number) => number | null) | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "duty-pool-wait-handoff-"));
  try {
    const agentDir = join(dir, "agent");
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(${JSON.stringify({ metrics: { wiki_problems: 22 }, flagged: FLAGGED })}));`);
    const store = new DutyStore(dir);
    await store.update(CHAT, duties => {
      duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays in sync", goal: "the wiki stays in sync",
        metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
        precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
        createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 1900, lastRunAt: STARTED } satisfies Duty);
    });
    await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "push", ms: 90_000, verdict: "missed",
      metrics: { wiki_problems: { value: 22, target: 0, op: "<=", met: false } }, summary: "wiki_problems 22 (target at most 0)", job: JOB });
    await mkdir(store.chatDir(CHAT), { recursive: true });
    // The 11-18 runs asked the makers, and the job's brief named all 22 pages.
    await writeFile(join(store.chatDir(CHAT), "d4.makers.json"), JSON.stringify(MADE.map(key)));
    await writeFile(join(store.chatDir(CHAT), "d4.handed.json"), JSON.stringify({ job: JOB.id, keys: FLAGGED.map(key) }));
    const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, true)],
      ...MAKER_TREES.map((tree): [string, SessionRow] => [tree, row(tree, `maker ${tree.slice(0, 8)}`, true)])]);
    const started: string[] = [];
    const messaged: string[] = [];
    const told: string[] = [];
    const summaries: string[] = [];
    const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
      rows: async () => [...rows.values()], schedules: async () => new Map(), treeFiles: id => treeFilesOf(id, agentDir) });
    const clock = { now: 0 };
    const duties = new Duties(store, {
      isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: () => {},
      poolHolds: async () => null,
      ...freeAt ? { writerFreeAt: async (tree: string) => { assert.equal(tree, CHAT); return freeAt(clock.now); } } : {},
      message: async (_session, tree) => { messaged.push(tree); },
      tell: async (_chat, text) => { told.push(text); return true; },
      jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
        kept: async job => job.id === JOB.id ? HELD : null,
        retire: async job => { rows.get(job.id)!.archived = true; },
        start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
    });
    try {
      for (const at of times) {
        clock.now = Date.parse(at);
        assert.ok(await duties.runNow(CHAT, "d4"));
        await duties.settled();
        summaries.push((await store.runs(CHAT)).find(record => record.at === clock.now)!.summary);
      }
      const makers = JSON.parse(await readFile(join(store.chatDir(CHAT), "d4.makers.json"), "utf8").catch(() => "[]")) as string[];
      return { summaries, started, messaged, told, makers };
    } finally { duties.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const waiting = (now: number) => now < BACK ? BACK : now;

test("a run beside a held dream job hands nobody the pages while pi-pool gives the chat no account, and says until when (11-19 14:58Z)", async () => {
  const { summaries, started, messaged, told } = await runsAt(["2026-11-19T14:58:00.000Z"], waiting);
  assert.deepEqual(started, [], "the held job stays");
  assert.ok(summaries[0]!.includes(`${STILL_WORKING} (job ${JOB.name} ${HELD})`), summaries[0]);
  assert.deepEqual(messaged, [], "no maker tree can write in the wait");
  assert.deepEqual(told, [], "no notice piles up in the chat's queue");
  assert.ok(summaries[0]!.includes("pi-pool gives this chat no account until 15:27Z, so no session can write the 22 flagged items now"), summaries[0]);
});

test("the first run after the pool wait hands every page that still counts again, to the makers at work and to the chat (11-19 15:29Z)", async () => {
  const { summaries, messaged, told, makers } = await runsAt(["2026-11-19T14:58:00.000Z", "2026-11-19T15:29:00.000Z", "2026-11-19T15:44:00.000Z"], waiting);
  assert.deepEqual(messaged.slice().sort(), MAKER_TREES.slice().sort(), "each maker tree at work is asked again after the wait");
  assert.ok(summaries[1]!.includes(`asked the sessions that made them to fix ${MADE.length} items`), summaries[1]);
  assert.equal(told.length, 1, summaries[1]);
  for (const slice of FLAGGED.filter(entry => !entry.maker)) assert.ok(told[0]!.includes(slice.item!), `${slice.item} reaches the chat`);
  assert.deepEqual(makers.slice().sort(), MADE.map(key).sort());
  assert.equal(messaged.length, MAKER_TREES.length, "the 15:44Z run asks nobody twice");
  assert.equal(told.length, 1, "the 15:44Z run tells the chat nothing twice");
});

test("without a pool reading the hand-off goes out as before", async () => {
  const { told, summaries } = await runsAt(["2026-11-19T14:58:00.000Z"], undefined);
  assert.ok(!summaries[0]!.includes("no account until"), summaries[0]);
  assert.equal(told.length, 1, summaries[0]);
});
