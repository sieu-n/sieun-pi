// 10-20: repeat_corrections_7d read 21 through five d10 runs while 19 of the 21 lines came before the fix their correction names now landed, so
// no run could see whether a fix held. The split shows it next to the headline: repeats_before_fix_7d, repeats_after_fix_7d, repeats_no_fix_7d.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyCorrection, fixRefs, parseLedger, type CountedRepeat, type Correction } from "../src/chat-corrections.ts";
import { firstFixLanded, fixLanded, fixMarks, gitCommitTime, sideLabel, splitLastEvents, splitMetrics, splitRepeats } from "../scripts/duties/repeat-split.ts";
import { measureHarness } from "../scripts/duties/harness-health.ts";

const at = Date.parse;
const now = at("2026-10-20T05:52:00Z");
const vp = { id: "01a1180e-6567-747f-bf44-452520ebdd1b", name: "VP of CI" };
const fb = { id: "01a11ba8-9d2c-727c-8ded-38f819ca9f29", name: "frontend bro" };
const commits: Record<string, string> = { "95af01d5": "2026-10-19T22:40:33Z", a46dee3: "2026-10-14T02:26:47Z", "06aa1dfb": "2026-10-19T22:42:55Z" };
const commitTime = async (hash: string) => commits[hash] ? at(commits[hash]!) : undefined;
const entry = (id: string, given: string, ref: string): Correction => ({ id, at: given, chat: vp, words: "w", rule: "r", enforcedBy: "brief", ref, status: "active", theme: [], repeats: [] });
const counted = (correction: Correction, said: string, chat = vp): CountedRepeat => ({ entry: correction, repeat: { at: said, chat, words: "again" }, said: at(said) });

const c79 = entry("c79", "2026-10-15T18:01:13.532Z", "sieun-pi 95af01d5: chat-board.ts refuses an agent todo that asks to contact a vendor's support (vendor-support.ts, test/vendor-support-todo.test.ts)");
const c118 = entry("c118", "2026-10-19T07:16:44.575Z", "mvex7ik9");
const c32 = entry("c32", "2026-10-09T21:53:55.449Z", "sieun-pi a46dee3 (c32-review-asks.test.ts: a review, look or pick todo with no link is refused)");

test("a ref's commits and the chat message ids sent after the correction are its fixes; the owner's own message id and a release name are not", () => {
  assert.deepEqual(fixMarks(c79.ref, at(c79.at), now), { commits: ["95af01d5"], messages: [], refines: [] });
  // c118's ref is the owner's 07:16:06Z message, from before the 07:16:44Z correction.
  assert.deepEqual(fixMarks(c118.ref, at(c118.at), now), { commits: [], messages: [], refines: [] });
  assert.deepEqual(fixMarks("msg mvfilflf (10-20): written into the brief", at("2026-10-12T06:55:55Z"), now), { commits: [], messages: [at("2026-10-19T17:14:48.243Z")], refines: [] });
  assert.deepEqual(fixMarks("live in release-1d6750a, 1792077437 and 12 messages", at("2026-10-12T00:00:00Z"), now), { commits: [], messages: [], refines: [] });
});

test("the newest landed fix a ref names dates it, and a commit no repo knows does not", async () => {
  assert.equal(await fixLanded("06aa1dfb + a46dee3 + fffffff1", at("2026-10-09T00:00:00Z"), now, commitTime), at(commits["06aa1dfb"]!));
  assert.equal(await fixLanded("fffffff1", at("2026-10-09T00:00:00Z"), now, commitTime), undefined);
});

test("the first landed fix a ref names after the correction dates the chase rule, and a commit from before the correction is no fix for it", async () => {
  assert.equal(await firstFixLanded("06aa1dfb + a46dee3 + fffffff1", at("2026-10-09T00:00:00Z"), now, commitTime), at(commits.a46dee3!));
  assert.equal(await firstFixLanded("06aa1dfb + a46dee3", at("2026-10-15T00:00:00Z"), now, commitTime), at(commits["06aa1dfb"]!));
  assert.equal(await firstFixLanded("a46dee3", at("2026-10-15T00:00:00Z"), now, commitTime), undefined);
});

test("c79's 10-19 'NONONO' came before 95af01d5, c118's 07:29Z line has no landed fix, and a line after a46dee3 is after its fix", async () => {
  const split = await splitRepeats([counted(c79, "2026-10-19T05:32:49.192Z"), counted(c118, "2026-10-19T07:29:01.410Z", fb),
    counted(c32, "2026-10-14T01:32:42.049Z", fb), counted(c32, "2026-10-14T03:00:00Z", fb)], now, commitTime);
  assert.deepEqual(split.map(item => [item.entry.id, item.side]), [["c79", "before_fix"], ["c118", "no_fix"], ["c32", "before_fix"], ["c32", "after_fix"]]);
  assert.deepEqual(splitMetrics(split), { repeats_before_fix_7d: 2, repeats_after_fix_7d: 1, repeats_no_fix_7d: 1 });
  assert.deepEqual(split.map(sideLabel), ["before fix of 10-19 22:40Z", "no landed fix", "before fix of 10-14 02:26Z", "after fix of 10-14 02:26Z"]);
});

test("gitCommitTime reads a commit's time from the first repo that has it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "repeat-split-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2026-10-19T22:40:33Z", GIT_AUTHOR_DATE: "2026-10-19T22:40:33Z" } }).trim();
  git("init", "-q");
  writeFileSync(join(repo, "a"), "a");
  git("add", "a");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
  const hash = git("rev-parse", "--short=8", "HEAD");
  const time = gitCommitTime([tmpdir(), repo]);
  assert.equal(await time(hash), at("2026-10-19T22:40:33Z"));
  assert.equal(await time("fffffff1"), undefined);
});

test("the d10 precheck reports the split next to repeat_corrections_7d and leads each line with its side", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "repeat-split-d10-"));
  const repeat = { at: "2026-10-19T06:00:13Z", chat: vp, words: "NONONONONONO" };
  writeFileSync(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [{ ...c79, repeats: [repeat] }] }));
  const output = await measureHarness({ roots: [], views: async () => [], dataDir, now, cache: async () => ({ metrics: { cache_read_ratio_1h: 95, cache_read_ratio_24h: 95 }, flagged: [] }),
    history: async () => ({ owner: [{ text: repeat.words, at: at("2026-10-19T05:32:49.192Z") }], refines: [] }), commitTime, transcripts: async () => [], smoke: { python: "python3" } });
  assert.equal(output.metrics.repeat_corrections_7d, 1);
  assert.deepEqual([output.metrics.repeats_before_fix_7d, output.metrics.repeats_after_fix_7d, output.metrics.repeats_no_fix_7d], [1, 0, 0]);
  const line = output.flagged!.find(slice => slice.kind === "repeat_corrections_7d")!;
  assert.equal(line.at, at("2026-10-19T05:32:49.192Z"));
  assert.match(line.excerpt, /^before fix of 10-19 22:40Z: c79 /);
});

test("a fix call that replaces a ref keeps the old one, so the landed fix it named still dates c18's repeats (10-22 09:41Z)", async () => {
  const landed = "sieun-pi 06aa1dfb (10-20 00:49Z: brief c18 line, tell_owner shop-talk refusal)";
  const ledger = { corrections: [entry("c18", "2026-10-09T14:27:39.767Z", landed)] };
  applyCorrection(ledger, { kind: "fix", fix: { id: "c18", ref: "Global owner_replies prompt note v8, refined 2026-10-22" } }, vp, "2026-10-22T09:41:00.000Z");
  const kept = parseLedger(JSON.parse(JSON.stringify(ledger))).corrections[0]!;
  assert.equal(kept.ref, "Global owner_replies prompt note v8, refined 2026-10-22");
  assert.deepEqual(kept.pastRefs, [{ ref: landed, until: "2026-10-22T09:41:00.000Z" }]);
  const split = await splitRepeats([counted(kept, "2026-10-19T13:51:23.127Z", fb), counted(kept, "2026-10-22T09:39:37.171Z", fb)], at("2026-10-22T13:15:00Z"), commitTime);
  assert.deepEqual(split.map(item => item.side), ["before_fix", "after_fix"]);
  assert.equal(await firstFixLanded(fixRefs(kept), at(kept.at), at("2026-10-22T13:15:00Z"), commitTime), at(commits["06aa1dfb"]!));
  applyCorrection(ledger, { kind: "fix", fix: { id: "c18", ref: kept.ref, status: "active" } }, vp, "2026-10-22T10:00:00.000Z");
  assert.equal(ledger.corrections[0]!.pastRefs!.length, 1);
});

test("a /refine id is a fix that landed at its UTC time, and one from before the correction is not (c104, 10-22)", async () => {
  const c104 = entry("c104", "2026-10-18T05:39:20.411Z", "refine_20261022063009003 (global owner-replies prompt notes v7 and v3 fold in c163)");
  const later = at("2026-10-22T13:15:00Z");
  assert.deepEqual(fixMarks(c104.ref, at(c104.at), later).refines, [at("2026-10-22T06:30:09.003Z")]);
  assert.deepEqual(fixMarks("refine_20261017000000000", at(c104.at), later).refines, []);
  const [split] = await splitRepeats([counted(c104, "2026-10-22T06:29:54.527Z")], later, commitTime);
  assert.equal(split!.side, "before_fix");
  assert.equal(sideLabel(split!), "before fix of 10-22 06:30Z");
  assert.equal(await firstFixLanded(c104.ref, at(c104.at), later, commitTime), at("2026-10-22T06:30:09.003Z"));
});

test("a repeat after any fix in place when the owner said it is after_fix, though a newer fix landed since (c117 and c78, 10-27; p1253)", async () => {
  const times: Record<string, string> = { b084c910: "2026-10-21T09:40:00Z", "18b73ec8": "2026-10-27T22:45:00Z", "0e90bb1421": "2026-10-22T12:16:55Z",
    "11b61b76c5": "2026-10-27T18:48:18Z", fc7490a1: "2026-10-27T20:00:00Z", "5f353fe0": "2026-10-27T22:30:00Z" };
  const time = async (hash: string) => times[hash] ? at(times[hash]!) : undefined;
  const later = at("2026-10-28T17:53:00Z");
  const c117 = { ...entry("c117", "2026-10-19T06:02:55.151Z", "sieun-pi 18b73ec8 (unread counts only lines sent to the owner)"),
    pastRefs: [{ ref: "tell_owner checks b084c910", until: "2026-10-27T22:51:24.515Z" }] };
  const c78 = { ...entry("c78", "2026-10-15T15:39:01.484Z", "auto-sns-agent 11b61b76c5 (shared-ui.test.ts maps each page to its shape)"),
    pastRefs: [{ ref: "shared-ui.test.ts extended in 0e90bb1421", until: "2026-10-27T23:38:42.735Z" }] };
  const split = await splitRepeats([counted(c117, "2026-10-27T18:43:55.446Z"), counted(c78, "2026-10-27T17:09:09.376Z", fb), counted(c78, "2026-10-22T11:32:44.624Z", fb)], later, time);
  assert.deepEqual(split.map(item => item.side), ["after_fix", "after_fix", "before_fix"]);
  assert.deepEqual(split.map(sideLabel), ["after fix of 10-21 09:40Z, fixed again 10-27 22:45Z", "after fix of 10-22 12:16Z, fixed again 10-27 18:48Z", "before fix of 10-27 18:48Z"]);
  assert.deepEqual(splitMetrics(split), { repeats_before_fix_7d: 1, repeats_after_fix_7d: 2, repeats_no_fix_7d: 0 });
  // Fixed again since, so the lines date the counts at the newest such fix and read quiet, as before_fix lines do.
  assert.deepEqual(splitLastEvents(split, later), { repeats_before_fix_7d: at(times["0e90bb1421"]!), repeats_after_fix_7d: at(times["18b73ec8"]!), repeat_corrections_7d: at(times["18b73ec8"]!) });
  // An after_fix line with no fix since stays open.
  const [open] = await splitRepeats([counted({ ...c117, ref: "tell_owner checks b084c910", pastRefs: [] }, "2026-10-27T18:43:55.446Z")], later, time);
  assert.equal(sideLabel(open!), "after fix of 10-21 09:40Z");
  assert.deepEqual(splitLastEvents([open!], later), { repeats_after_fix_7d: later, repeat_corrections_7d: later });
  // The commit a test fails on is the old tip, no fix: c157's ref names fc7490a1, a pi-pool commit that landed before nothing of c157's.
  const c157 = entry("c157", "2026-10-22T04:56:58.979Z", "sieun-pi 5f353fe0 (test token-cost-c157.test.ts fails on fc7490a1)");
  assert.deepEqual(fixMarks(c157.ref, at(c157.at), later).commits, ["5f353fe0"]);
  assert.deepEqual(fixMarks("shared-ui.test.ts (fails at 8883b9521a on a layout, passes at 7979da5081)", at(c78.at), later).commits, ["7979da5081"]);
  const [cost] = await splitRepeats([counted(c157, "2026-10-27T21:00:00Z")], later, time);
  assert.equal(cost!.side, "before_fix");
});
