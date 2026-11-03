// The chat service's own start is planned work, as a Prime update is. After the 07:33:33Z release restart on 11-03, the reopened tabs' older
// pages waited behind the start's work and api/threads/<id>/older answered in 3.8 s; 7 of 37 chat starts from 11-02 on cost d7 a dirty minute.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CpuSides, LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";
import { CHAT_WARMUP_MS, measure, readChatStarts } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-11-03T07:41:51Z");
const START = Date.parse("2026-11-03T07:11:00Z");
const cores: CpuSides = { harness: 29.9, apps: 8, owner: 0, ci: 6, system: 2 };
const box: LinuxUsable = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 58, swapoutsPerS: 0, runnablePerCore: 1.7, allowedCpus: 80, cpuCores: cores };
const at = (minute: number) => new Date(START + minute * 60_000 + 30_000).toISOString();
const slowAt = 23; // 07:34:30Z
const watch = (): WatchLine[] => Array.from({ length: 30 }, (_, minute) => ({ at: at(minute), host: "us-metal02", usable: box, workers: 20, workerGb: 30,
  top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0,
  chat: minute === slowAt ? { readMs: 3800, read: "api/threads/01a1301d/older", loopMs: 361 } : { readMs: 80, read: "api/agent/siblings", loopMs: 300 } }));
const started = Date.parse("2026-11-03T07:33:33.000Z");

test("service.log's listening lines are the chat's starts", () => {
  assert.deepEqual(readChatStarts(["2026-11-03T07:33:33.000Z serve: listening 3924 ms after start, main thread CPU 3317 ms, from the bundle", "2026-11-03T07:33:40.000Z catalog: 40 projections"]), [started]);
});

test("a slow chat read within the warm-up of a chat start is the start's minute, not dirty", () => {
  const { metrics, flagged } = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [], chatStarts: [started] });
  assert.equal(metrics.clean_min_30, 30);
  assert.equal(metrics.chat_start_min_30, 1);
  assert.match(flagged?.find(slice => slice.kind === "chat_start")?.excerpt ?? "", /07:34Z us-metal02 the chat answered api\/threads\/01a1301d\/older in 3\.8 s, 57 s after the chat started at 07:33Z/);
});

test("the same read with no start in the warm-up, or beside a worker poll miss, stays dirty", () => {
  const far = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [], chatStarts: [Date.parse(at(slowAt)) - 60_000 - CHAT_WARMUP_MS - 1] });
  assert.equal(far.metrics.clean_min_30, 29);
  assert.equal(far.metrics.chat_start_min_30, 0);
  const missed = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [], chatStarts: [started], workerMisses: [Date.parse("2026-11-03T07:34:10Z")] });
  assert.equal(missed.metrics.clean_min_30, 29);
});
