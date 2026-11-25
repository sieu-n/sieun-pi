// d7's dirty line for the Mac's swap minute at 05:57Z on 11-20 (6,433 swapouts a second) named "the largest jump since 05:56Z was Aside
// +0.25 GB (1.93 to 2.18 GB), swap 15.5 to 10.5 GB", the largest rise. The minute's cause was a drop: the owner's Helium went from 13.04 to
// 1.29 GB as it quit or restarted, and the browsers group from 37.43 to 25.89 GB. The fixture is the watch's 05:56:30Z and 05:57:30Z lines with
// the Mac's part as written and a calm us-metal02 reading in place of that box's own. The minute itself now reads usable, as a swapouts minute
// at pressure level 1 while swap shrinks (swap-freeing-minute.test.ts), so the first test reads it at warn to keep the line it names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostViews, jumpWords, measure } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const lines = JSON.parse(readFileSync(new URL("fixtures/mac-helium-quit-1120-0557.json", import.meta.url), "utf8")) as WatchLine[];
const NOW = Date.parse("2026-11-20T05:58:10Z");
const noOwner = () => undefined;
const mac = (line: WatchLine) => hostViews(line).find(view => view.name === "mac")!;

test("a Mac swap minute names the holder that dropped most when the drop is the largest change", () => {
  const [before, after] = structuredClone(lines);
  (mac(after!).usable as { pressureLevel: number }).pressureLevel = 2;
  const { flagged } = measure({ now: NOW, watch: [before!, after!], log: { holds: [] }, chats: [] });
  const line = (flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "").split("\n").find(entry => entry.startsWith("05:57Z")) ?? "";
  assert.match(line, /the largest change since 05:56Z was Helium -11\.75 GB \(13\.04 to 1\.29 GB, it quit, restarted or released memory\), swap 15\.5 to 10\.5 GB/);
  assert.doesNotMatch(line, /Aside \+0\.25 GB/);
});

test("a holder that left a short feed list dropped to nothing", () => {
  const [before, after] = structuredClone(lines);
  const usable = mac(after!).usable as { owners: { owner: string }[] };
  usable.owners = usable.owners.filter(feed => feed.owner !== "browser:helium");
  const words = jumpWords([before!, after!], noOwner)(after!, mac(after!));
  assert.match(words, /^; the largest change since 05:56Z was Helium -13\.04 GB \(13\.04 to 0 GB, it quit, restarted or released memory\)/);
});
