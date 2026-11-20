// Guards d7's 07:16Z minute on 11-20: the relay read the Mac "fetch failed" at 07:16:30Z between usable reads at 07:15:30Z and 07:17:30Z, every
// daemon handshake to it timed out from 07:15:54Z to 07:16:52Z, and Tailscale did not read it offline until 07:21Z, so d7 counted 07:16Z unknown
// and read 29 of 30 clean. The fixtures are the real watch lines from 07:14Z to 07:18Z and the chat service's prime-calls.jsonl lines in them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type HostCall, measure, readHostCalls } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const lines = (name: string): string[] => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
const watch = lines("mac-link-drop-1120-watch.jsonl").map(text => JSON.parse(text) as WatchLine);
const calls = readHostCalls(lines("mac-link-drop-1120-calls.jsonl"), 0);
const RUN = Date.parse("2026-11-20T07:29:31Z");
const run = (hostCalls: readonly HostCall[]) => measure({ now: RUN, watch, log: { holds: [] }, chats: [], hostCalls });

test("a Mac minute whose relay read and every daemon call to it failed on the link counts offline and names the dropped link", () => {
  assert.equal(calls.filter(call => call.host === "mac" && call.at >= Date.parse("2026-11-20T07:16:00Z") && call.at < Date.parse("2026-11-20T07:17:00Z")).length, 13);
  const out = run(calls);
  assert.equal(out.metrics.offline_min_30_mac, 1);
  assert.equal(out.metrics.unknown_min_30_mac, 0);
  assert.equal(out.metrics.usable_min_30_mac, 4);
  const words = out.flagged?.find(slice => slice.kind === "offline_minutes")?.excerpt ?? "";
  assert.match(words, /mac offline 07:16Z/);
  assert.match(words, /the link to the box dropped, relay and daemon both unreached \(07:16Z mac\)/);
});

test("the same minute stays unknown when a daemon call to the Mac answered in it, because only the relay failed", () => {
  const answered: HostCall = { at: Date.parse("2026-11-20T07:16:40Z"), host: "mac", method: "list", outcome: "ok" };
  const out = run([...calls, answered]);
  assert.equal(out.metrics.offline_min_30_mac, 0);
  assert.equal(out.metrics.unknown_min_30_mac, 1);
  assert.equal(run([]).metrics.unknown_min_30_mac, 1, "with no daemon calls read, the relay alone leaves the minute unknown");
});

test("a call that failed for another reason than a lost link keeps the minute unknown", () => {
  const slow: HostCall = { at: Date.parse("2026-11-20T07:16:45Z"), host: "mac", method: "get_state", outcome: "timeout" };
  assert.equal(run([...calls, slow]).metrics.unknown_min_30_mac, 1);
});
