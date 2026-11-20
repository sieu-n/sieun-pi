// d7's dirty line for the Mac's swap minute at 00:43Z on 11-20 (8,020 swapouts a second, swap 18.9 to 20.7 GB) named only "the largest jump
// since 00:42Z was Aside +0.09 GB". The memory sat in the owner's browsers: over the hour before, Google Chrome held 21.5 to 22.9 GB and Helium
// grew from 6.98 to 10.13 GB, with WebKit WebContent near 7 GB. The fixture is the watch's 23:43:30Z, 00:42:30Z and 00:43:30Z lines with the
// Mac's part as written and a calm us-metal02 reading in place of that box's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostViews, holderWords, measure } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const lines = JSON.parse(readFileSync(new URL("fixtures/mac-browser-climb-1120-0043.json", import.meta.url), "utf8")) as WatchLine[];
const NOW = Date.parse("2026-11-20T00:44:10Z");
const noOwner = () => undefined;
const dirtyLine = (day: readonly WatchLine[]): string => {
  const { flagged } = measure({ now: NOW, watch: lines.slice(1), day, log: { holds: [] }, chats: [] });
  return (flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "").split("\n").find(line => line.startsWith("00:43Z")) ?? "";
};

test("a Mac swap minute names its 3 largest holders and their growth over the hour before", () => {
  const line = dirtyLine(lines);
  assert.match(line, /the largest holders were Google Chrome 22\.85 GB \(\+1\.34 GB since 23:43Z\), Helium 10\.13 GB \(\+3\.15 GB\), com\.apple\.WebKit\.WebContent 6\.95 GB \(-0\.09 GB\)/);
});

test("with no reading in the hour before, the holders come without growth", () => {
  const after = lines[2]!;
  const words = holderWords([after], noOwner)(after, hostViews(after).find(view => view.name === "mac")!);
  assert.equal(words, "; the largest holders were Google Chrome 22.85 GB, Helium 10.13 GB, com.apple.WebKit.WebContent 6.95 GB");
});

test("a Linux reading names no holders", () => {
  const after = lines[2]!;
  const box = hostViews(after).find(view => view.name !== "mac")!;
  assert.equal(holderWords(lines, noOwner)(after, box), "");
});
