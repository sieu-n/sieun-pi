// d10 of 10-20 16:40 KST: repeat_corrections_7d read 21 against 0 for 8 runs, all 21 lines before their fix, and every run's miss line asked
// for a fix job (p770, then p793) that could not move a count that only waits for its lines to leave the 7 days. The precheck now dates each
// count with lastEventAt (splitLastEvents), so such a headline reads quiet while an open after_fix or no_fix line keeps it live.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Correction } from "../src/chat-corrections.ts";
import { missLine } from "../src/chat-duty-job.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";
import { splitLastEvents, type SplitRepeat } from "../scripts/duties/repeat-split.ts";
import { measureHarness } from "../scripts/duties/harness-health.ts";

const at = Date.parse;
const now = at("2026-10-20T07:40:00Z");
const vp = { id: "01a1180e-6567-747f-bf44-452520ebdd1b", name: "VP of CI" };
const commits: Record<string, string> = { "95af01d5": "2026-10-19T22:40:33Z", "06aa1dfb": "2026-10-19T22:42:55Z" };
const commitTime = async (hash: string) => commits[hash] ? at(commits[hash]!) : undefined;
const entry = (id: string, given: string, ref: string): Correction => ({ id, at: given, chat: vp, words: "w", rule: "r", enforcedBy: "brief", ref, status: "active", theme: [], repeats: [] });
const line = (correction: Correction, said: string, side: SplitRepeat["side"], fixed?: string): SplitRepeat =>
  ({ entry: correction, repeat: { at: said, chat: vp, words: "again" }, said: at(said), side, ...(fixed ? { fixed: at(fixed) } : {}) });

const c79 = entry("c79", "2026-10-15T18:01:13.532Z", "sieun-pi 95af01d5");
const c18 = entry("c18", "2026-10-09T03:00:00Z", "sieun-pi 06aa1dfb");
const c118 = entry("c118", "2026-10-19T07:16:44.575Z", "mvex7ik9");

test("lines that all came before their fix date the headline from the newest fix landing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "repeat-quiet-"));
  const said = { c79: "2026-10-19T05:32:49Z", c18: "2026-10-19T13:51:00Z" };
  writeFileSync(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [
    { ...c79, repeats: [{ at: said.c79, chat: vp, words: "NONONONO" }] }, { ...c18, repeats: [{ at: said.c18, chat: vp, words: "short please" }] }] }));
  const output = await measureHarness({ roots: [], views: async () => [], dataDir, now, cache: async () => ({ metrics: { cache_read_ratio_1h: 95, cache_read_ratio_24h: 95 }, flagged: [] }),
    history: async () => ({ owner: [{ text: "NONONONO", at: at(said.c79) }, { text: "short please", at: at(said.c18) }], refines: [] }), commitTime, transcripts: async () => [], smoke: { python: "python3" } });
  assert.deepEqual([output.metrics.repeat_corrections_7d, output.metrics.repeats_before_fix_7d], [2, 2]);
  assert.deepEqual(output.lastEventAt, { repeat_corrections_7d: at(commits["06aa1dfb"]!), repeats_before_fix_7d: at(commits["06aa1dfb"]!) });

  const metric: DutyMetric = { key: "repeat_corrections_7d", label: "Owner corrections he had to give again in the last 7 days, all chats", op: "<=", target: 0, headline: true };
  const run = (time: string): DutyRunRecord => ({ duty: "d10", at: at(time), trigger: "schedule", ms: 1, ...judge([metric], output) });
  const [streak] = metricStreaks([run("2026-10-20T07:40:00Z"), run("2026-10-20T06:15:00Z"), run("2026-10-19T21:46:00Z")]);
  assert.equal(streak!.quietSince, at(commits["06aa1dfb"]!));
  assert.equal(streak!.stuck, false);
  assert.match(missLine("d10", streak!, metric.label), /Start no new job for it/);
});

test("an open no_fix line keeps the headline live at every run, so a real repeat still starts a job", () => {
  const split = [line(c79, "2026-10-19T05:32:49Z", "before_fix", commits["95af01d5"]), line(c118, "2026-10-19T07:29:01Z", "no_fix")];
  assert.deepEqual(splitLastEvents(split, now), { repeat_corrections_7d: now, repeats_before_fix_7d: at(commits["95af01d5"]!), repeats_no_fix_7d: now });
  const after = [line(c18, "2026-10-20T01:00:00Z", "after_fix", commits["06aa1dfb"])];
  assert.deepEqual(splitLastEvents(after, now), { repeat_corrections_7d: now, repeats_after_fix_7d: now });
});

test("an empty window has no event and gives no lastEventAt", () => {
  assert.deepEqual(splitLastEvents([], now), {});
});
