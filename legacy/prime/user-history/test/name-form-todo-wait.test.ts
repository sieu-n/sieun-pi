// api portal vp 10-31: p121, the fix step of d1/probes_down_now, waited for "CI and RepoOps's t108", the owner's open For you todo to walk prod
// promote 66290c6693 (c154). d9's 22:37Z run read d1 as a fix not moving, because the duty fleet linked other chats' todos with no chat catalog,
// so a wait that names a chat by its name linked no todo. Every place that links another chat's todos resolves a name with the catalog.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyFleet } from "../scripts/duties/duty-fleet.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { endState } from "../src/checkin-end-state.ts";
import { stepView } from "../src/checkin-steps.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import { dutyHold, heldByTodo, withBoardLinks, withLinkedBoards } from "../src/shared/todo-hold.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const PORTAL = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const CI = "01a1180e-6567-747f-bf44-452520ebdd1b";
const chats = [{ id: PORTAL, name: "api portal vp", archived: false }, { id: CI, name: "CI and RepoOps", archived: false }];
const now = Date.parse("2026-10-31T22:37:00Z");
const p121: PlanItem = { id: "p121", text: "Prod api.virev.ai/docs shows the Scalar reference signed out once the docs reach main", status: "blocked", children: [],
  job: "prod docs on scalar watch", duty: "d1/probes_down_now", waitFor: "CI and RepoOps's t108" };
const t108 = (done: boolean): OwnerTodo => ({ id: "t108", text: "Put staging 66290c6693 on production now?", done, from: "agent", at: "2026-10-29T02:24:41.403Z", step: "p412" });
const board = (plan: PlanItem[], todos: OwnerTodo[] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-31T22:00:00Z", plan, todos }) as ChatBoard;
const portal = board([p121]);
const ci = (done: boolean): ChatBoard => board([], [t108(done)]);

test("a wait that names another chat by its name holds its step on that chat's open For you todo", async () => {
  const linked = withLinkedBoards(portal, PORTAL, new Map([[CI, ci(false)]]), chats);
  assert.equal(heldByTodo(p121, linked.todos), true);
  assert.equal(dutyHold("d1", ["probes_down_now"], linked), `p121 on t108 on thread ${CI}`);
  const read = await withBoardLinks(portal, PORTAL, async chat => chat === CI ? ci(false) : null, chats);
  assert.equal(dutyHold("d1", ["probes_down_now"], read), `p121 on t108 on thread ${CI}`);
  assert.equal(dutyHold("d1", ["probes_down_now"], withLinkedBoards(portal, PORTAL, new Map([[CI, ci(true)]]), chats)), undefined, "a done todo holds nothing");
  assert.equal(dutyHold("d1", ["probes_down_now"], withLinkedBoards(portal, PORTAL, new Map([[CI, ci(false)]]), [])), undefined, "no catalog names no chat");
});

test("the linked todo holds only the steps whose waits name it", () => {
  const other: PlanItem = { id: "p122", text: "Another step", status: "blocked", children: [], waitFor: "t108" };
  const linked = withLinkedBoards(board([p121, other]), PORTAL, new Map([[CI, ci(false)]]), chats);
  assert.equal(heldByTodo(other, linked.todos), false);
});

test("the check-in reads a name-form wait on another chat's open todo as For you", () => {
  const linked = withLinkedBoards(portal, PORTAL, new Map([[CI, ci(false)]]), chats);
  const view = stepView(p121, now - 8 * 3_600_000, new Set([PORTAL]), [], [], [], now);
  assert.equal(endState(view, linked.todos, chats, new Set([PORTAL]), now).state, "foryou");
});

const run = (at: number): DutyRunRecord => ({ duty: "d1", at, trigger: "schedule", ms: 1, verdict: "missed", summary: "",
  metrics: { probes_down_now: { value: 1, target: 0, op: "<=", met: false } } });

test("d9's duty fleet counts the duty as held on the owner, not as a fix that does not move", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [PORTAL, CI] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    await mkdir(join(dataDir, "boards"), { recursive: true });
    const d1 = { id: "d1", name: "Portal stays up", ownerWords: "keep it up", goal: "It is up.", metrics: [{ key: "probes_down_now", label: "probes down", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 60 }, precheck: { command: ["true"] }, onMiss: "Fix it.", status: "active", runCount: 6 };
    await writeFile(join(dataDir, "duties", `${PORTAL}.json`), JSON.stringify({ version: 1, duties: [d1] }));
    await writeFile(join(dataDir, "duties", `${CI}.json`), JSON.stringify({ version: 1, duties: [] }));
    await writeFile(join(dataDir, "boards", `${PORTAL}.json`), JSON.stringify(portal));
    await writeFile(join(dataDir, "boards", `${CI}.json`), JSON.stringify(ci(false)));
    const store = new DutyStore(dataDir);
    for (let hour = 1; hour <= 6; hour++) await store.appendRun(PORTAL, run(now - (7 - hour) * 3_600_000));
    const fleet = await dutyFleet({ dataDir, now, sessions: () => [], chats });
    assert.equal(fleet.duties.find(entry => entry.chat === PORTAL && entry.duty === "d1")?.held, `p121 on t108 on thread ${CI}`);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("the whole-system count leaves the held duty out of the red duties", () => {
  const inputs = (done: boolean) => ({ now, chats: [{ id: PORTAL, name: "api portal vp", runs: [run(now - 30 * 60_000)], duties: [{ id: "d1", name: "Portal stays up" }], paused: false,
    everyMs: 120 * 60_000 }, { id: CI, name: "CI and RepoOps", runs: [], duties: [], paused: false, everyMs: 120 * 60_000 }],
    boards: new Map([[PORTAL, portal], [CI, ci(done)]]), ownerActivity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map() }) as unknown as PlanInputs;
  assert.equal(planCounts(inputs(false)).redDuties.length, 0);
  assert.equal(planCounts(inputs(true)).redDuties.length, 1);
});
