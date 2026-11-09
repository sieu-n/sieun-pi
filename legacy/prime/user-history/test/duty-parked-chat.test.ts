// Replays the AI harness chat's Wiki dream (d4) of 11-09. Its job "wiki dream AI harness developer environment 22:59" (01a1c09c) got claude21 at
// 14:01Z, wrote 27 of its 28 pages by 14:05Z, and from 14:05:37Z pi-pool parked its tree with no account (claude21 limited to 17:59:59Z, claude10
// to 20:59:59Z). The runs from 16:30Z to 18:03Z kept it as POOL_PARKED, which hands the job nothing, and read wiki_problems 5, then 8 and 12.
// 7 pages had a maker, and each run asked the trees at work. The other 5 had none: take-in e3dd9060ea put 4 behind with no Session-Id, and one
// cites `landed:93cfff858e`. Those 5 reached nobody until a subagent of the chat, which rode the chat's pi-pool slot from 18:15:30Z, fixed them
// by 18:20Z (~/work/d4-held-pages-1110). A run beside a parked job now hands the chat the items no maker was asked to fix.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PoolHold } from "../src/chat-pool.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties, IN_POOL_LINE, POOL_PARKED } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { treeFilesOf } from "../src/send-once.ts";
import { type Duty, type DutyJobRef, type FlaggedSlice, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a1c09c-7a5d-7134-9d2b-21481c929984", name: "wiki dream AI harness developer environment 22:59" };
const STARTED = Date.parse("2026-11-09T13:59:34.020Z");
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const API_PORTAL = "01a1301d-18de-7129-a559-cfb92f9b5fb1";

const page = (item: string, sig: string, excerpt: string, maker?: FlaggedSlice["maker"]): FlaggedSlice =>
  ({ kind: "stale_vs_code", item, excerpt, handOff: true, sig, ...maker ? { maker } : {} });
/** The 12 hand-off items of the 17:16:42Z run (d4-261110-0216.json). */
const FLAGGED = [
  page("apps/convex/schema.html", "2026-11-09T10:24:59.999Z", "checked 2026-11-09T10:24Z (last_verified 2026-11-09T10:24Z); code changed since: convex/removed-tables.txt (2026-11-09T13:38Z)", { commit: "bbd55f170c3fc7058d95a13cc3d7976e1302030b", session: "01a1bca4-55fb-778b-a5a1-dca8a7ee3c0a", tree: "01a15c6c-8bec-71fe-b7d3-1fac79a315c9" }),
  page("domains/devops/getting-started.html", "2026-11-09T14:04Z", "checked 2026-11-09T14:04Z (last_verified 2026-11-09T14:04Z); code changed since: landed:93cfff858e (d86d682ad9 land: dev/sieun 47deead7b, dev/sieun-mac 38077e78c): \"At 14:04Z on 2026-11-09 no staging land carried 93cfff858e yet.\" (2026-11-…"),
  page("domains/devops/stability-pipeline/push-ci/probes.html", "2026-11-09T01:15:59.999Z", "checked 2026-11-09T01:15Z (last_verified 2026-11-09T01:15Z); code changed since: apps/infra/ci-server/minter/ci02_app_minter.py::LOW_PRIORITY_PATHS (2026-11-09T14:04Z)", { commit: "4d100ca0a3088c08cbd5ab8dfa0739057407bfe5", session: "01a1c080-7a7a-740e-97e2-5bf205f3c55f", tree: "01a1ba78-7815-77b8-9adc-b40247e66f1c" }),
  page("domains/architecture/ci-deploy/runners.html", "2026-11-09T01:16:59.999Z", "checked 2026-11-09T01:16Z (last_verified 2026-11-09T01:16Z); code changed since: apps/infra/ci-server/minter/ci02_app_minter.py::LOW_PRIORITY_PATHS (2026-11-09T14:04Z)", { commit: "4d100ca0a3088c08cbd5ab8dfa0739057407bfe5", session: "01a1c080-7a7a-740e-97e2-5bf205f3c55f", tree: "01a1ba78-7815-77b8-9adc-b40247e66f1c" }),
  page("domains/devops/ci-time/changes-since-10-19-runners.html", "2026-11-09T01:15:59.999Z", "checked 2026-11-09T01:15Z (last_verified 2026-11-09T01:15Z); code changed since: apps/infra/ci-server/minter/ci02_app_minter.py::LOW_PRIORITY_PATHS (2026-11-09T14:04Z)", { commit: "4d100ca0a3088c08cbd5ab8dfa0739057407bfe5", session: "01a1c080-7a7a-740e-97e2-5bf205f3c55f", tree: "01a1ba78-7815-77b8-9adc-b40247e66f1c" }),
  page("apps/search/brand-tracking-ui.html", "2026-11-09T08:31:59.999Z", "checked 2026-11-09T08:31Z (last_verified 2026-11-09T08:31Z); behind since 16:26Z, counted from 17:36Z; code changed since: apps/search/tests/unit/handle-not-found.test.ts (2026-11-09T16:26Z)", { commit: "8e2ee5a3234e9d0044212573f064210c3fcc10e4", session: "01a1c11e-0ace-7708-bfb9-37609d3bde14", tree: "01a189ec-9db2-754e-9028-07c0a8c5a789" }),
  page("experiments/2026-10-29-profile-entity-resolution/audits.html", "2026-11-09T05:43:59.999Z", "checked 2026-11-09T05:43Z (last_verified 2026-11-09T05:43Z); behind since 16:33Z, counted from 17:43Z; code changed since: apps/crawler-v3/src/catalog/resolve/policy.py::RULES_VERSION (2026-11-09T16:33Z), apps/crawler-v3/src/catalog/resolv…", { commit: "44103e90c6743f9cfb05030e9979dc2ee7b4f055", session: "01a1842f-9a44-72c6-a2f4-14f02171ac3c", tree: "01a115e2-9544-7204-b8db-8ce4d5319048" }),
  page("experiments/email-finder/platform-reveal-mechanisms.html", "2026-11-09T14:03:59.999Z", "checked 2026-11-09T14:03Z (last_verified 2026-11-09T14:03Z); behind since 16:36Z, counted from 17:46Z; code changed since: apps/crawler-v3/src/contacts/find/store.py::_stored_sql (2026-11-09T16:36Z)", { commit: "35c1440c00172355637c02ec8e01508dc137b318", session: "01a1ba95-9cc3-750b-b3aa-320db44f6227", tree: "01a1301d-18de-7129-a559-cfb92f9b5fb1" }),
  page("domains/devops/ci-cd-pipeline/land-and-promote-withheld.html", "2026-11-09T14:04:59.999Z", "checked 2026-11-09T14:04Z (last_verified 2026-11-09T14:04Z); behind since 16:42Z, counted from 17:52Z; code changed since: scripts/repo/agent/take-in.mjs::planTakeIn (2026-11-09T16:42Z)"),
  page("domains/devops/ci-time/changes-since-10-19-land-merge.html", "2026-11-09T14:03:59.999Z", "checked 2026-11-09T14:03Z (last_verified 2026-11-09T14:03Z); behind since 16:42Z, counted from 17:52Z; code changed since: scripts/repo/agent/take-in.mjs::planTakeIn (2026-11-09T16:42Z)"),
  page("domains/devops/production-runbook.html", "2026-11-09T14:03:59.999Z", "checked 2026-11-09T14:03Z (last_verified 2026-11-09T14:03Z); behind since 16:42Z, counted from 17:52Z; code changed since: .agents/skills/repo/git-workflow/SKILL.md::Ship a change (2026-11-09T16:42Z)"),
  page("domains/devops/ci-cd-pipeline/ship-loop.html", "2026-11-09T13:34:59.999Z", "checked 2026-11-09T13:34Z (last_verified 2026-11-09T13:34Z); behind since 16:42Z, counted from 17:52Z; code changed since: .agents/skills/repo/git-workflow/SKILL.md::Ship a change (2026-11-09T16:42Z)"),
];
const key = (slice: FlaggedSlice) => `${slice.kind}|${slice.item}|${slice.sig}`;
/** The makers.json the 16:30Z and 17:01Z runs wrote: the 4 pages of code cut 3 and push verdict burst wait, and the Monitor UI page. */
const ASKED = FLAGGED.filter(slice => slice.maker && ![CRAWLER, API_PORTAL].includes(slice.maker.tree)).map(key);
const NO_MAKER = FLAGGED.filter(slice => !slice.maker).map(slice => slice.item!);

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 93, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
const reply = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "27 of 28 pages are done." }], stopReason: "toolUse" } });
const slotWait = (at: string, slot: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", provider: "anthropic", content: [],
  stopReason: "error", errorMessage: `token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at ${slot}.` } });

async function runsAt(times: readonly string[], hold: PoolHold | null) {
  const dir = await mkdtemp(join(tmpdir(), "duty-parked-chat-"));
  try {
    const agentDir = join(dir, "agent");
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await writeFile(join(agentDir, "sessions", `${JOB.id}.jsonl`),
      [reply("2026-11-09T14:05:17.249Z"), slotWait("2026-11-09T17:00:04.300Z", "2026-11-09T18:07:00.000Z")].join("\n") + "\n");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(${JSON.stringify({ metrics: { wiki_problems: 5 }, flagged: FLAGGED })}));`);
    const store = new DutyStore(dir);
    await store.update(CHAT, duties => {
      duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays in sync", goal: "the wiki stays in sync",
        metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
        precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
        createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 900, lastRunAt: STARTED } satisfies Duty);
    });
    await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "verify", ms: 67_695, verdict: "met",
      metrics: { wiki_problems: { value: 0, target: 0, op: "<=", met: true } }, summary: "wiki_problems 0 (on target); all 4 on target", job: JOB });
    await mkdir(store.chatDir(CHAT), { recursive: true });
    await writeFile(join(store.chatDir(CHAT), "d4.makers.json"), JSON.stringify(ASKED));
    const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, true)],
      [CRAWLER, row(CRAWLER, "Crawler VP", true)], [API_PORTAL, row(API_PORTAL, "api portal vp", true)]]);
    const started: string[] = [];
    const steered: string[] = [];
    const messaged: string[] = [];
    const told: { chat: string; text: string }[] = [];
    const summaries: string[] = [];
    const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
      rows: async () => [...rows.values()], schedules: async () => new Map(), treeFiles: id => treeFilesOf(id, agentDir) });
    const clock = { now: 0 };
    const duties = new Duties(store, {
      isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: () => {},
      poolHolds: async tree => tree === JOB.id ? hold : null,
      message: async (_session, tree) => { messaged.push(tree); },
      tell: async (chat, text) => { told.push({ chat, text }); return true; },
      jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
        retire: async job => { rows.get(job.id)!.archived = true; },
        steer: async job => { steered.push(job.id); },
        start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
    });
    try {
      for (const at of times) {
        clock.now = Date.parse(at);
        assert.ok(await duties.runNow(CHAT, "d4"));
        await duties.settled();
        summaries.push((await store.runs(CHAT)).find(record => record.at === clock.now)!.summary);
      }
      return { summaries, started, steered, messaged, told };
    } finally { duties.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a run beside a pool-parked dream job hands the chat the pages no maker was asked to fix (11-09 17:16:42Z)", async () => {
  const { summaries, started, steered, messaged, told } = await runsAt(["2026-11-09T17:16:42.674Z", "2026-11-09T17:32:12.857Z"], null);
  assert.deepEqual(started, [], "p1514 keeps the parked job");
  assert.ok(summaries[0]!.includes(`${STILL_WORKING} (job ${JOB.name} ${POOL_PARKED})`), summaries[0]);
  assert.deepEqual(messaged.sort(), [API_PORTAL, CRAWLER].sort(), "the two maker trees at work are asked, as at 17:16Z");
  assert.deepEqual(steered, [], "the parked job takes no message");
  assert.equal(told.length, 1, "one notice to the chat");
  assert.equal(told[0]!.chat, CHAT);
  for (const item of NO_MAKER) assert.ok(told[0]!.text.includes(item), `${item} reaches the chat`);
  for (const slice of FLAGGED.filter(entry => entry.maker)) assert.ok(!told[0]!.text.includes(slice.item!), `${slice.item} stays with its maker`);
  assert.ok(told[0]!.text.startsWith("[check-in] "), "a server note, so the turn it starts is not the owner's");
  assert.ok(told[0]!.text.includes("subagent of this chat"), told[0]!.text);
  assert.ok(summaries[0]!.endsWith(`asked the sessions that made them to fix 2 items; handed the chat ${NO_MAKER.length} new flagged items`), summaries[0]);
  assert.equal(told.length, 1, "the 17:32Z run hands the chat no page twice");
  assert.ok(!summaries[1]!.includes("handed the chat"), summaries[1]);
});

test("a dream job held in pi-pool's line still takes the run's items itself, and the chat gets none", async () => {
  const { summaries, steered, told } = await runsAt(["2026-11-09T17:16:42.674Z"], "line");
  assert.ok(summaries[0]!.includes(IN_POOL_LINE), summaries[0]);
  assert.deepEqual(steered, [JOB.id]);
  assert.deepEqual(told, []);
});
