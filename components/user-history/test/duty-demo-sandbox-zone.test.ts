// Guards frontend bro's d1 run of 10-18 06:36Z on us-metal02: the precheck ran under the chat service's TZ=Asia/Seoul, read pm2's UTC log
// times as KST, and flagged restarts at 17:17, 19:46 and 20:55Z on 10-17 that happened at 02:17, 04:46 and 05:55Z on 10-18.
process.env.TZ = "Asia/Seoul";
import assert from "node:assert/strict";
import { test } from "node:test";
import { logTime, pm2Zone, restarts } from "../scripts/duties/demo-sandbox.ts";

const PM2_LOG = [
  "2026-10-18T02:17:25: PM2 log: Stopping app:virev-demo id:7",
  "2026-10-18T02:17:26: PM2 log: App [virev-demo:7] exited with code [0] via signal [SIGINT]",
  "2026-10-18T04:46:39: PM2 log: Stopping app:virev-demo id:6",
  "2026-10-18T04:46:39: PM2 log: App [virev-demo:6] exited with code [0] via signal [SIGINT]",
  "2026-10-18T05:55:36: PM2 log: Stopping app:virev-demo id:7",
  "2026-10-18T05:55:38: PM2 log: App [virev-demo:7] exited with code [0] via signal [SIGINT]",
].join("\n");
const RUN_AT = Date.parse("2026-10-18T06:36:37Z");
const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + "Z";

test("a box pm2.log written in UTC reads in UTC under a KST process", () => {
  const { events, planned } = restarts(PM2_LOG, undefined, RUN_AT, "Etc/UTC");
  assert.deepEqual(events, []);
  assert.deepEqual(planned.map(exit => iso(exit.at)), ["2026-10-18T02:17:26Z", "2026-10-18T04:46:39Z", "2026-10-18T05:55:38Z"]);
});

test("a Mac pm2.log written in KST still reads in KST", () => {
  assert.equal(iso(logTime("2026-10-18T11:17:26: PM2 log: x", "Asia/Seoul")!), "2026-10-18T02:17:26Z");
  assert.equal(logTime("no time here", "UTC"), null);
});

test("a zone with daylight time reads each side of the change", () => {
  assert.equal(iso(logTime("2026-07-01T12:00:00: x", "America/New_York")!), "2026-07-01T16:00:00Z");
  assert.equal(iso(logTime("2026-12-01T12:00:00: x", "America/New_York")!), "2026-12-01T17:00:00Z");
});

test("the zone comes from the pm2 daemon, then the host, never this process", async () => {
  const files: Record<string, string> = { "/pm2/pm2.pid": "2904638\n", "/proc/2904638/environ": "HOME=/home/sieun\0PATH=/usr/bin\0" };
  const read = async (path: string) => { if (path in files) return files[path]!; throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); };
  assert.equal(await pm2Zone("/pm2", read, async () => "/usr/share/zoneinfo/Etc/UTC"), "Etc/UTC");
  assert.equal(await pm2Zone("/pm2", read, async () => "/var/db/timezone/zoneinfo/Asia/Seoul"), "Asia/Seoul");
  files["/proc/2904638/environ"] = "TZ=Europe/Berlin\0HOME=/home/sieun\0";
  assert.equal(await pm2Zone("/pm2", read, async () => "/usr/share/zoneinfo/Etc/UTC"), "Europe/Berlin");
  assert.equal(await pm2Zone("/none", read, async () => { throw new Error("ENOENT"); }), "UTC");
});
