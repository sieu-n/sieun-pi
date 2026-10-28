// The catalog line's "main thread N% busy" read 76 to 82% every day from 10-20, when the always-on run profile started, while the CPU profiles'
// own samples had the main thread busy 36% (14:53 to 15:27Z on 10-28). eventLoopUtilization counts the loop as busy each time the profiler's
// sampler wakes it; an idle loop under the profiler read 0.86. The line now reads the main thread's own CPU time over the window.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { test, type TestContext } from "node:test";
import { mainThreadBusy } from "../src/chat-catalog.ts";

/** Runs this thread for `ms` of its own CPU time, so a loaded box or a parallel suite still gets the same work. */
const cpuMs = (): number => { const used = process.threadCpuUsage(); return (used.user + used.system) / 1000; };
const burn = (ms: number): void => { const until = cpuMs() + ms; while (cpuMs() < until) { /* busy */ } };
const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

test("the busy share is the thread's CPU time over the wall time between two reads", () => {
  let wall = 1000, cpu = 50;
  const busy = mainThreadBusy(() => wall, () => cpu);
  wall += 60_000; cpu += 21_600;
  assert.equal(busy(), 0.36);
  wall += 1000;
  assert.equal(busy(), 0);
  assert.equal(busy(), 0, "no wall time passed");
});

test("an idle loop under a running CPU profiler reads near 0% busy, and a loop that works 30 ms of every 100 reads about 30%", async (t: TestContext) => {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 1000 });
  await session.post("Profiler.start");
  t.after(async () => { await session.post("Profiler.stop").catch(() => {}); session.disconnect(); });
  const busy = mainThreadBusy();
  await wait(1500);
  const idle = busy();
  assert.ok(idle < 0.15, `idle loop read ${(idle * 100).toFixed(1)}% busy`);
  const started = performance.now();
  let burnt = 0;
  const timer = setInterval(() => { burn(30); burnt += 30; }, 100);
  await wait(1500);
  clearInterval(timer);
  const working = busy();
  const share = burnt / (performance.now() - started);
  assert.ok(working >= share * 0.9 && working < share + 0.15, `30 ms of CPU per timer tick (${(share * 100).toFixed(1)}% of the window) read ${(working * 100).toFixed(1)}% busy`);
});
