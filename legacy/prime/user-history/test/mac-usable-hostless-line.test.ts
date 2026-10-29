// 10-29: release-516eb84 ran the chat service on us-metal02 from 20:11:16Z to 20:13:28Z with no hosts.json, which it threw on, and wrote the three
// watch lines in fixtures/mac-usable-hostless-1029.jsonl with no `host` and no `hosts`. The reader named a line with no box the Mac, so d1's
// 20:33Z run counted the 20:11Z line, us-metal02 at 2.16 runnable a core, as a red Mac minute ("cpu 1") while Tailscale read the Mac offline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { macUnusableMinutes } from "../scripts/duties/local-dev-uptime.ts";
import { hostViews, UNNAMED_HOST, UNNAMED_LINUX_HOST } from "../scripts/duties/whole-system.ts";

const lines = readFileSync(new URL("./fixtures/mac-usable-hostless-1029.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line) as WatchLine);

test("a line with no box and a Linux reading is no Mac minute", () => {
  assert.deepEqual(lines.map(line => [line.at, line.host, line.usable && "kind" in line.usable ? line.usable.kind : null]), [
    ["2026-10-29T20:11:30.020Z", undefined, "linux"], ["2026-10-29T20:12:30.025Z", undefined, "linux"], ["2026-10-29T20:13:26.656Z", undefined, "linux"]]);
  assert.deepEqual(lines.map(line => hostViews(line).map(view => view.name)), [[UNNAMED_LINUX_HOST], [UNNAMED_LINUX_HOST], [UNNAMED_LINUX_HOST]]);
  assert.deepEqual(macUnusableMinutes(lines), { read: 0, unusable: 0, by: {} });
});

test("a Linux reading the Mac's name carries is not counted as the Mac's", () => {
  assert.deepEqual(macUnusableMinutes(lines.map(line => ({ ...line, host: "mac" }))), { read: 0, unusable: 0, by: {} });
});

test("a line with no box and a Mac reading is still the Mac's, as before 10-18", () => {
  const line = { at: "2026-10-17T10:00:00.000Z", usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 300 }, workers: 0, workerGb: 0, top: [] } as unknown as WatchLine;
  assert.equal(hostViews(line)[0]!.name, UNNAMED_HOST);
  assert.equal(macUnusableMinutes([line]).read, 1);
});
