// Guards the d3 false repeat of 10-18: audit 13533 (10-16 05:08Z) raised census rates, said "no box stop since 00:40Z", and read as an F2 repeat 48 h later.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { type AuditRow, type HandData, type RefState, auditSql, classifyConfig, groupAudit, parseRegistry, report } from "../scripts/duties/hand-fixes.ts";

const DIR = join(import.meta.dirname, "..", "scripts", "duties");
const AT = Date.parse("2026-10-16T05:08:27Z");
const REASON = "Climb for p71: 160 gave 5,400-5,850 census ok/min (03:15-04:45Z) against 4,550-4,900 at 128, TikTok Shop -2%, engage -5%, writer lag under line, " +
  "no box stop since 00:40Z. cc 160 -> 192, new 13500 -> 16000; judged at about 05:40Z on all lanes' good results per hour. Go 2026-10-16 05:08Z.";
const rows = (ts: number): AuditRow[] => [13533, 13534].map((id, index) => ({ id, ts, actor: "api-key", source: "ops-api", reason: REASON,
  key: index ? "instagram_census.new_per_minute" : "instagram_census.crawl_concurrency" }));
const registry = async () => parseRegistry(JSON.parse(await readFile(join(DIR, "hand-fixes.faults.json"), "utf8")));
const refs = (): Map<string, RefState> => new Map([["01a115e2-9544-7204-b8db-8ce4d5319048/p173", { kind: "step", status: "done" }],
  ["01a115e2-9544-7204-b8db-8ce4d5319048/p170", { kind: "step", status: "doing" }]]);
const data = async (now: number, prod: AuditRow[]): Promise<HandData> => ({ now, registry: await registry(), refs: refs(), audit: { prod, staging: [] }, events: {}, errors: [] });
const metrics = async (now: number) => parseDutyInput(JSON.parse(await readFile(join(DIR, "hand-fixes.duty.json"), "utf8")), "d", now).metrics;

test("audit 13533 is a lane rate change of F1, since a guard named in the prose does not beat the keys", async () => {
  const [fix] = groupAudit("prod", rows(AT));
  const verdict = classifyConfig(fix!, await registry());
  assert.equal(verdict.kind === "fault" && verdict.fault.id, "F1");
  const now = AT + 3_600_000;
  const output = report(await data(now, rows(AT)), await metrics(now));
  assert.equal(output.metrics.repeats_after_design, 0);
});

test("a guard's own tagged write from a session still counts as an F2 repeat, and the supervised box stop unit does not", async () => {
  const reg = await registry();
  const guard = classifyConfig({ actor: "api-key", writer: "ops-api", keys: ["pause.instagram_census"], text: "watch_proxy abort: transport 12% of 626 attempts" }, reg);
  assert.equal(guard.kind === "fault" && guard.fault.id, "F2");
  const watch = classifyConfig({ actor: "tiktok-shop-thread", writer: "ops-script", keys: ["pause.tiktok_shop"], text: "TikTok Shop prod watch --act: writer lag 1239" }, reg);
  assert.equal(watch.kind === "fault" && watch.fault.id, "F2");
  const unit = classifyConfig({ actor: "metal", writer: "metal-box-stop-loop", keys: ["pause.instagram_census"], text: "metal box stop: prod io pressure full avg300 9.85% >= 8" }, reg);
  assert.equal(unit.kind, "automatic");
  const now = AT + 3_600_000;
  const tagged = rows(AT).map(row => ({ ...row, reason: "watch_proxy abort: transport 12% of 626 attempts" }));
  assert.equal(report(await data(now, tagged), await metrics(now)).metrics.repeats_after_design, 1);
});

test("the 24 h metrics leave out a 48 h old fix and say so, and the read reaches 24 h back past the last run's mark", async () => {
  const now = AT + 48 * 3_600_000;
  const tagged = rows(AT).map(row => ({ ...row, reason: "watch_proxy abort: transport 12% of 626 attempts" }));
  const output = report(await data(now, tagged), await metrics(now));
  assert.equal(output.metrics.repeats_after_design, 0);
  assert.match(output.flagged!.find(slice => slice.kind === "hand_fixes")!.excerpt, /1 older changes since the last run are outside the 24 h metrics/);
  assert.match(auditSql(14021, now), /\(id > 14021 or ts >= to_timestamp\(\d+\)\) order by id$/);
});
