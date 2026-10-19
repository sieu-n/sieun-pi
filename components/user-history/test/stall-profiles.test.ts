// Guards the stall profiler the d7 cpu share job added on 10-19: a 20 s window whose event loop stalled over 1 s is saved while
// <data dir>/stall-profiles exists, and nothing is profiled or written while it does not.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { profileName, STALL_PROFILE_DIR, startStallProfiles } from "../src/stall-profiles.ts";

function stallTheLoopForMs(ms: number): number {
  const end = Date.now() + ms;
  let spins = 0;
  while (Date.now() < end) spins++;
  return spins;
}

test("a window whose loop stalled over 1 s is saved as a profile that names the blocking function", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stall-profiles-"));
  try {
    await mkdir(join(dataDir, STALL_PROFILE_DIR));
    const lines: string[] = [];
    const profiles = startStallProfiles({ dataDir, log: line => lines.push(line), windowMs: 300 });
    await delay(400);
    stallTheLoopForMs(1300);
    await delay(700);
    await profiles.stop();
    const saved = (await readdir(join(dataDir, STALL_PROFILE_DIR))).filter(name => name.endsWith(".cpuprofile"));
    assert.equal(saved.length, 1, lines.join("\n"));
    assert.match(saved[0]!, /-1[2-9]\d\dms\.cpuprofile$|-[2-9]\d{3}ms\.cpuprofile$/);
    const profile = JSON.parse(await readFile(join(dataDir, STALL_PROFILE_DIR, saved[0]!), "utf8")) as { nodes: { callFrame: { functionName: string } }[] };
    assert.ok(profile.nodes.some(node => node.callFrame.functionName === "stallTheLoopForMs"));
    assert.deepEqual(lines.filter(line => !line.startsWith("stall profiles: on") && line !== "stall profiles: off"), []);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("without the folder nothing is profiled or written", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stall-profiles-"));
  try {
    const lines: string[] = [];
    const profiles = startStallProfiles({ dataDir, log: line => lines.push(line), windowMs: 200 });
    await delay(300);
    stallTheLoopForMs(1200);
    await delay(400);
    await profiles.stop();
    assert.deepEqual(await readdir(dataDir), []);
    assert.deepEqual(lines, []);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a profile's name sorts by time and shows the stall", () => {
  assert.equal(profileName(new Date("2026-10-19T23:05:20.123Z"), 1544.6), "2026-10-19T23-05-20-123Z-1545ms.cpuprofile");
});
