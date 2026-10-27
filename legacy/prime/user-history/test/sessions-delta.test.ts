// Guards the 10-18 sessions feed: the service sent all 2553 rows (1.37 MB) about once a second, and a thread snapshot waited 13 to 30 s behind them on the Mac.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applySessionsDelta, SessionsDiff } from "../src/shared/sessions-delta.ts";
import type { ChatAgent, SessionRow, SessionsDelta, SessionsEvent } from "../src/shared/types.ts";

const BASE = Date.parse("2026-10-18T05:00:00Z");
const row = (n: number, at: number, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: `id-${n}`, name: `thread ${n}`, cwd: "/home/sieun", lastActivityAt: new Date(BASE + at).toISOString(), ...extra }) as SessionRow;
const sorted = (rows: SessionRow[]) => [...rows].sort((left, right) => Date.parse(right.lastActivityAt ?? "") - Date.parse(left.lastActivityAt ?? ""));
const event = (rows: SessionRow[]): SessionsEvent => ({ type: "sessions", sessions: sorted(rows), tags: [], daemon: "up" });

const agent = (key: number, step: number): ChatAgent => ({ key: `child:sub-${key}`, name: `job ${key}`, state: "working", lastActivityAt: new Date(BASE + step).toISOString() }) as ChatAgent;
/** One change to a chat's agents: an agent's activity moves, a new one starts, one leaves, a key shows twice, or the list turns around. */
function churn(agents: ChatAgent[], step: number, random: () => number): ChatAgent[] {
  const roll = random();
  const pick = Math.floor(random() * Math.max(agents.length, 1));
  if (roll < 0.4 && agents.length) return agents.map((item, index) => index === pick ? { ...item, lastActivityAt: new Date(BASE + step * 7).toISOString() } : item);
  if (roll < 0.7) return [...agents, agent(step, step)];
  if (roll < 0.8) return agents.filter((_, index) => index !== pick);
  if (roll < 0.9 && agents[pick]) return [...agents, { ...agents[pick], name: `same key ${step}` }];
  return [...agents].reverse();
}

/** A new name, and `unread` set on even steps and dropped on odd ones. */
function renamed(item: SessionRow, step: number): SessionRow {
  const { unread: _unread, ...rest } = item;
  return step % 2 === 0 ? { ...rest, name: `renamed ${step}`, unread: true } : { ...rest, name: `renamed ${step}` } as SessionRow;
}

/** A frame as the page reads it, after JSON on the socket. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What the page holds after each frame, the way src/client/api.ts sessionsStream folds them. */
function page() {
  let rows: SessionRow[] = [];
  return { take(frame: SessionsEvent | SessionsDelta | null) { if (frame) rows = frame.type === "sessions" ? frame.sessions : applySessionsDelta(rows, frame); return rows; } };
}

test("the first frame is the whole list, then only changed rows go out, and nothing goes out when nothing changed", () => {
  const diff = new SessionsDiff();
  const rows = Array.from({ length: 50 }, (_, n) => row(n, n * 1000));
  assert.equal(diff.frame(event(rows))?.type, "sessions");
  assert.equal(diff.frame(event(rows.map(item => ({ ...item })))), null);
  const changed = rows.map(item => item.id === "id-7" ? { ...item, unread: true } : item);
  const frame = diff.frame(event(changed));
  assert.equal(frame?.type, "sessions-delta");
  assert.deepEqual(frame?.type === "sessions-delta" && frame.patch, [{ id: "id-7", set: { unread: true } }]);
  assert.equal(frame?.type === "sessions-delta" && frame.order, undefined);
});

test("the page rebuilds the server's exact list through moves, new rows, removals and ties", () => {
  const diff = new SessionsDiff();
  const client = page();
  let rows = Array.from({ length: 40 }, (_, n) => row(n, n * 1000));
  let next = 40;
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let step = 0; step < 600; step++) {
    const pick = Math.floor(random() * rows.length);
    const roll = random();
    if (roll < 0.35) rows = rows.map((item, index) => index === pick ? { ...item, lastActivityAt: new Date(BASE + 100_000 + step * 1000).toISOString() } : item);
    else if (roll < 0.45) rows = [...rows, row(next++, 100_000 + step * 1000)];
    else if (roll < 0.55 && rows.length > 5) rows = rows.filter((_, index) => index !== pick);
    else if (roll < 0.65) rows = rows.map((item, index) => index === pick ? { ...item, lastActivityAt: rows[0]?.lastActivityAt ?? "" } : item);
    else if (roll < 0.75) rows = rows.map((item, index) => index === pick ? renamed(item, step) : item);
    else rows = rows.map((item, index) => index === pick % 3 ? { ...item, agents: churn(item.agents ?? [], step, random) } : item);
    const sent = event(rows);
    assert.deepEqual(client.take(wire(diff.frame(sent))), wire(sent.sessions), `step ${step}`);
  }
});

test("a delta is a small part of the full list when a few chats change", () => {
  const diff = new SessionsDiff();
  const rows = Array.from({ length: 2500 }, (_, n) => row(n, n * 1000, { agents: Array.from({ length: n % 40 }, (_, key) => agent(key, n)) }));
  const full = diff.frame(event(rows));
  const busy = rows.map(item => item.id === "id-3" || item.id === "id-9" ? { ...item, lastActivityAt: new Date(BASE + 9_000_000 + (item.id === "id-3" ? 1 : 2)).toISOString() } : item);
  const delta = diff.frame(event(busy));
  assert.equal(delta?.type === "sessions-delta" && delta.order, undefined);
  const oneAgent = busy.map(item => item.id === "id-39" ? { ...item, agents: (item.agents ?? []).map(entry => entry.key === "child:sub-5" ? { ...entry, state: "done" } : entry) } as SessionRow : item);
  assert.deepEqual(diff.frame(event(oneAgent)), { type: "sessions-delta", add: [], remove: [], tags: [], daemon: "up",
    patch: [{ id: "id-39", agents: { upsert: [{ ...agent(5, 39), state: "done" }], remove: [] } }] });
  assert.ok(JSON.stringify(delta).length * 50 < JSON.stringify(full).length);
});
