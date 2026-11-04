// d7's dirty line for the Mac's swap minute at 07:21Z on 11-04 named "agents' Aside tabs 1 of 4, about 0.83 GB", its share of Aside by tab
// count, because one agent tab opened that minute. The cause was a `pnpm check` (tsgo with an 8 GB heap) that a sep launch!! job started in
// apps/search at 07:20:55Z: the feed's sep launch!! owner went from below its 8 largest to 7.52 GB and swap from 11.5 to 13.3 GB. The fixture is
// the watch's 07:20:30Z and 07:21:30Z lines with the Mac's part as written and a calm us-metal02 reading in place of that box's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostViews, jumpWords, measure } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const lines = JSON.parse(readFileSync(new URL("fixtures/mac-swap-jump-1104-0721.json", import.meta.url), "utf8")) as WatchLine[];
const NOW = Date.parse("2026-11-04T07:22:10Z");
const dirtyLine = (watch: readonly WatchLine[]): string => {
  const { flagged } = measure({ now: NOW, watch, log: { holds: [] }, chats: [] });
  return (flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "").split("\n").find(line => line.startsWith("07:21Z")) ?? "";
};

test("a Mac swap minute names the owner whose memory jumped most since the minute before", () => {
  const line = dirtyLine(lines);
  assert.match(line, /the largest jump since 07:20Z was chat sep launch!! \(product guy\) \+6\.97 GB \(0\.55 to 7\.52 GB\), swap 11\.5 to 13\.3 GB/);
  assert.doesNotMatch(line, /Aside tabs/);
});

test("with no line the minute before, the Mac minute keeps the agents' Aside tab share", () => {
  assert.match(dirtyLine(lines.slice(1)), /agents' Aside tabs 1 of 4, about 0\.83 GB/);
});

test("a job rig that grew most is named by its owner and dir", () => {
  const [before, after] = structuredClone(lines);
  after!.hosts![0]!.jobRigs = [{ dir: "work/mps-bench", gb: 9.5, pids: 3, command: "python run_mps_bench.py" }];
  const words = jumpWords([before!, after!], () => ({ chat: "Crawler VP", job: "small model classify" }))(after!, hostViews(after!)[1]!);
  assert.match(words, /^; the largest jump since 07:20Z was job rig Crawler VP, job small model classify in ~\/work\/mps-bench \+9\.5 GB \(0 to 9\.5 GB\)/);
});
