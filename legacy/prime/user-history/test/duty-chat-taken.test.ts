// Replays the AI harness chat's Wiki dream (d4) of 11-10. The 00:30Z run handed the chat 11 pages while pi-pool held the 09:14 job for its
// slot, and the chat's "wiki stale pages 0929" subagent took them. The job worked again from 01:19Z and started writers for the same pages
// from 01:25Z. At 01:31Z the job's root had a quota-resume job while its subagent split-retrieval-backfill split
// apps/crawler-v3/adding-a-platform/retrieval-backfill.html, and the 01:33Z run handed the chat that page too, so the chat split it a second
// time and two child pages had to be set superseded. Each item now has one owner at a time: the job skips what the chat took, and a run beside
// a job whose tree works hands the chat only the items that job was never handed.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties, POOL_PARKED } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { treeFilesOf } from "../src/send-once.ts";
import { type Duty, type DutyJobRef, type FlaggedSlice, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow, ThreadSchedule } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MAKER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const T0 = Date.parse("2026-11-10T00:15:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const page = (item: string, maker?: boolean): FlaggedSlice => ({ kind: "stale_vs_code", item, excerpt: `checked 2026-11-09T21:16Z; code changed since`,
  handOff: true, sig: "2026-11-09T21:16:59.999Z", ...maker ? { maker: { commit: "44103e90c6743f9cfb05030e9979dc2ee7b4f055", session: "01a1842f-9a44-72c6-a2f4-14f02171ac3c", tree: MAKER } } : {} });
const A = page("domains/email-deliverability/index.html");
const B = page("apps/convex/functions.html");
const C = page("domains/devops/ci-cd-pipeline/land-and-promote-withheld.html", true);
const D = page("domains/devops/ci-time/changes-since-10-19-land-pick.html", true);
const E = page("domains/devops/production-runbook.html");
const F: FlaggedSlice = { kind: "near_read_cap", item: "apps/crawler-v3/adding-a-platform/retrieval-backfill.html", excerpt: "64,210 B, read cap 65,536 B", handOff: true };
const key = (slice: FlaggedSlice) => `${slice.kind}|${slice.item}${slice.sig === undefined ? "" : `|${slice.sig}`}`;

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 40, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
const reply = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Starting the writers." }], stopReason: "toolUse" } });
const slotWait = (at: string, slot: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", provider: "anthropic", content: [],
  stopReason: "error", errorMessage: `token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at ${slot}.` } });

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "duty-chat-taken-"));
  const agentDir = join(dir, "agent");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  const flaggedFile = join(dir, "flagged.json");
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { readFileSync, writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 5 }, flagged: JSON.parse(readFileSync(${JSON.stringify(flaggedFile)}, "utf8")) }));`);
  const store = new DutyStore(dir);
  await store.update(CHAT, duties => {
    duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays in sync", goal: "the wiki stays in sync",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
      createdAt: T0 - 86_400_000, updatedAt: T0 - 86_400_000, runCount: 900 } satisfies Duty);
  });
  const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [MAKER, row(MAKER, "Crawler VP", true)]]);
  const schedules = new Map<string, ThreadSchedule>();
  const briefs: string[] = [];
  const steered: string[] = [];
  const told: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
    rows: async () => [...rows.values()], schedules: async () => schedules, treeFiles: id => treeFilesOf(id, agentDir) });
  const clock = { now: T0 };
  const duties = new Duties(store, {
    isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: () => {},
    poolHolds: async () => null,
    message: async () => {},
    tell: async (_chat, text) => { told.push(text); return true; },
    jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
      retire: async job => { rows.get(job.id)!.archived = true; },
      steer: async (_job, text) => { steered.push(text); },
      start: async (_chat, name, brief) => { const id = "01a1c2ce-e85a-73e3-963b-1ff226e291c0"; briefs.push(brief); rows.set(id, row(id, name, true)); return { id, name }; } },
  });
  const transcript = (job: DutyJobRef) => join(agentDir, "sessions", `${job.id}.jsonl`);
  const run = async (minutes: number, flagged: readonly FlaggedSlice[]) => {
    clock.now = T0 + minutes * 60_000;
    await writeFile(flaggedFile, JSON.stringify(flagged));
    assert.ok(await duties.runNow(CHAT, "d4"));
    await duties.settled();
    return (await store.runs(CHAT)).find(record => record.at === clock.now)!;
  };
  return { dir, store, rows, schedules, briefs, steered, told, run, transcript, close: async () => { duties.close(); await rm(dir, { recursive: true, force: true }); } };
}

/** What a job does with its brief's line: the items it was handed, less each one whose kind and item open a key in the file the brief names. */
async function workList(brief: string, handed: readonly FlaggedSlice[]): Promise<string[]> {
  const file = /read (\S+chat-handed\.json) if it exists/.exec(brief)?.[1];
  assert.ok(file, "the brief names the list of items the chat took");
  const taken: string[] = await readFile(file, "utf8").then(text => JSON.parse(text) as string[], () => []);
  return handed.filter(slice => !taken.some(entry => entry.startsWith(`${slice.kind}|${slice.item}|`) || entry === `${slice.kind}|${slice.item}`)).map(slice => slice.item!);
}

test("a dream job that gets its slot after the chat took 2 of its pages works only the rest (11-10 00:30Z and 01:19Z)", async () => {
  const r = await rig();
  try {
    const first = await r.run(0, [A, B, C, D]);
    const job = first.job!;
    assert.ok(job, first.summary);
    await writeFile(r.transcript(job), [reply(iso(1)), slotWait(iso(2), iso(120))].join("\n") + "\n");
    const parked = await r.run(100, [A, B, C, D, F]);
    assert.ok(parked.summary.includes(`${STILL_WORKING} (job ${job.name} ${POOL_PARKED})`), parked.summary);
    assert.equal(r.told.length, 1, parked.summary);
    for (const slice of [A, B, F]) assert.ok(r.told[0]!.includes(slice.item!), `${slice.item} reaches the chat`);
    for (const slice of [C, D]) assert.ok(!r.told[0]!.includes(slice.item!), `${slice.item} stays with its maker`);
    // The job gets its slot and works again; the next run hands it only the page nobody took.
    await appendFile(r.transcript(job), reply(iso(125)) + "\n");
    await r.run(130, [A, B, C, D, F, E]);
    assert.equal(r.steered.length, 1);
    assert.ok(r.steered[0]!.includes(E.item!), r.steered[0]);
    assert.ok(!r.steered[0]!.includes(F.item!), "the page the chat took is never handed to the job");
    assert.equal(r.told.length, 1, "the chat gets no page twice");
    assert.deepEqual(await workList(r.briefs[0]!, [A, B, C, D, E]), [C.item, D.item, E.item]);
  } finally { await r.close(); }
});

test("a run beside a job whose root waits on a quota-resume while its subagents work hands the chat only the pages that job was never handed (11-10 01:33Z)", async () => {
  const r = await rig();
  try {
    const first = await r.run(0, [A, F]);
    const job = first.job!;
    await writeFile(r.transcript(job), reply(iso(70)) + "\n");
    r.schedules.set(job.id, { kind: "cron", label: "quota-resume", status: "active", expression: "once" });
    const held = await r.run(78, [A, F, E]);
    assert.ok(held.summary.includes("quota-resume"), held.summary);
    assert.equal(r.told.length, 1, held.summary);
    assert.ok(r.told[0]!.includes(E.item!), r.told[0]);
    for (const slice of [A, F]) assert.ok(!r.told[0]!.includes(slice.item!), `${slice.item} stays with the job whose subagents work`);
  } finally { await r.close(); }
});

test("a new job of the duty starts with an empty list of pages the chat took", async () => {
  const r = await rig();
  try {
    await mkdir(r.store.chatDir(CHAT), { recursive: true });
    await writeFile(join(r.store.chatDir(CHAT), "d4.chat-handed.json"), JSON.stringify([key(A)]));
    await r.run(0, [A, B]);
    assert.deepEqual(await workList(r.briefs[0]!, [A, B]), [A.item, B.item]);
  } finally { await r.close(); }
});
