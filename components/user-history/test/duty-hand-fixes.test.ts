// Guards the d3 false repeat of 10-18: audit 13533 (10-16 05:08Z) raised census rates, said "no box stop since 00:40Z", and read as an F2 repeat 48 h later.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { type AuditRow, type HandData, type RefState, auditSql, classifyConfig, groupAudit, handExecs, isSessionProcess, nextState, oneOffs, parseBox, parseRegistry, report } from "../scripts/duties/hand-fixes.ts";

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

// Guards d3 p146: audits 13970, 13971 and 13994 (10-17 and 10-18) had no fault for 3 runs, and an undesigned write was gone by the next run.
const hand = (id: number, ts: number, key: string, reason: string): AuditRow => ({ id, ts, actor: "api-key", source: "ops-api", key, reason });

test("the canary and doc_id hand writes of 10-17 and 10-18 are F15 and F16, and a writer's named fault wins over the keys", async () => {
  const reg = await registry();
  const fault = (keys: string[], text: string) => { const verdict = classifyConfig({ actor: "api-key", writer: "ops-api", keys, text }, reg); return verdict.kind === "fault" ? verdict.fault.id : verdict.kind; };
  assert.equal(fault(["engage.canary_pct"], "check-in 22:45Z 10-17 (owner rule: always ~10% canary): raise the live canary cohort"), "F15");
  assert.equal(fault(["engage.canary_offset"], "d1 kill-cause job 03:2xZ 10-18: the 2,000-a-day canary killed 5"), "F15");
  assert.equal(fault(["doc_ids.refresh_enabled", "doc_id_profile_posts"], "watchlist last fixes: doc_id_profile_posts 28834890909485062"), "F16");
  assert.equal(fault(["pause.crawl"], "F16: the refresher wrote a dead id, so the crawl waits"), "F16");
  assert.equal(fault(["engage.canary_pct"], "F99: a fault nobody listed"), "undesigned");
  assert.equal(fault(["supply_hold.enabled"], "Crawler ops 06:0xZ (c72): supply hold root cause"), "F18");
  assert.equal(fault(["media.video_concurrency"], "instagram ingest backlog job, 07:40Z: step 16->48"), "F19");
  assert.equal(classifyConfig({ actor: "canary-roster", keys: ["engage.canary_roster"], text: "roster refill" }, reg).kind, "automatic");
});

// Guards the d3 reds of 10-18 16:4xZ: audits 14089, 14107, 14217, 14221 and 14235 read as 5 undesigned writes and 3 faults without a job.
test("the 10-18 throttle steps are F1, the deep backfill stop is F21, and the owner's dated pause.enrich order is exempt", async () => {
  const reg = await registry();
  const fault = (keys: string[], text: string) => { const verdict = classifyConfig({ actor: "api-key", writer: "ops-api", keys, text }, reg); return verdict.kind === "fault" ? verdict.fault.id : verdict.kind; };
  assert.equal(fault(["throttle.crawl_per_minute.instagram", "throttle.deep_crawl_per_minute.tiktok"], "c100 (owner 10-18 02:14Z: push GeoNode to 150 MB/s) supersedes the 09-11 spend pause"), "F1");
  assert.equal(fault(["deep_backfill.enabled"], "p625 stopgap (alerts-b-feeder, crawler prod alerts job, parent go): prod 43490e7e9f sweep_deep_backfill fills crawl_profile"), "F21");
  assert.equal(fault(["pause.enrich", "pause.enrich.owner", "pause.enrich.expires_at"], "pause.enrich owner decided: the owner's order of 2026-10-13: 'can we not enrich for now?' (For you todo t32)"), "exempt");
  assert.equal(fault(["pause.enrich"], "pause.enrich: the owner's order, as I read it"), "undesigned");
});

test("a hand write no fault covers is filed and counts as a fault without a job until the registry lists one for its key", async () => {
  const now = AT + 3_600_000;
  const first = await data(now, [hand(20001, AT, "lane.new_knob", "raise the new knob")]);
  const base = report({ ...first, audit: { prod: [], staging: [] } }, await metrics(now)).metrics.faults_without_job!;
  const one = report(first, await metrics(now));
  assert.equal(one.metrics.undesigned_hand_fixes, 1);
  assert.equal(one.metrics.faults_without_job, base + 1);
  const state = nextState({}, first);
  assert.deepEqual(state.filed!.map(entry => entry.keys), [["lane.new_knob"]]);
  const later = now + 3_600_000;
  const second = { ...await data(later, [hand(20002, AT + 7_200_000, "lane.new_knob", "again")]), filed: state.filed ?? [] };
  const two = report(second, await metrics(later));
  assert.equal(two.metrics.undesigned_hand_fixes, 0);
  assert.equal(two.metrics.faults_without_job, base + 1);
  assert.equal(nextState(state, second).filed!.length, 1);
  const listed = { ...second, registry: { ...second.registry!, faults: [...second.registry!.faults, { id: "F99", title: "new knob", designs: ["p1"], owner: "t", match: { config_key_prefixes: ["lane."] } }] } };
  assert.deepEqual(nextState(state, listed).filed, []);
  assert.equal(report(listed, await metrics(later)).metrics.faults_without_job, base + 1);
});

// Guards d3 p145: the 05:21Z run of 10-18 counted 13 execs in virev-prod-crawler-worker; 12 were /tmp lane scripts (F17) and 1 the declared B2 inventory unit.
test("the prod B2 inventory exec is its declared unit, and the hand-run lane writers and crawlers are F17", async () => {
  const reg = await registry();
  const exec = (command: string) => ({ container: "virev-prod-crawler-worker", service: "crawler-worker", running: true, command });
  const script = (name: string) => exec(`sh -c dotenvx-start.sh /app/apps/crawler-v3/.venv/bin/python /tmp/${name}.py >> /tmp/${name}.1.log 2>&1`);
  const inventory = exec('sh -c cd /app/apps/crawler-v3 && exec nice -n 10 dotenvx run -q -f "$DOTENV_FILE" -- .venv/bin/python -c "$0" "$@" ' +
    '#!/usr/bin/env python3\n"""Daily B2 version inventory for ONE bucket, with a per-part checkpoint so a run resumes.');
  const lanes = ["cw_extra_writer", "mw_extra_writer", "tts_extra_crawler"].map(script);
  assert.deepEqual(handExecs([inventory, ...lanes], reg.exempt.box_exec_regex), lanes);
  const f17 = reg.faults.find(fault => fault.id === "F17")!;
  assert.ok(lanes.every(lane => new RegExp(f17.match.box_exec_regex!).test(lane.command)));
  assert.ok(f17.designs.includes("01a11bd7-072f-7591-ad1d-f123c276cde5/p145"));
});

// Guards the d3 run after promote 12 on 10-18: the CI reds job's gate script copy read as 3 session writers, and an exited container as a hand-run one.
test("a CI gate or test script in a session folder and an exited container are not hand-run processes", () => {
  const session = "/home/sieun/Documents/Github/auto-sns-agent/apps/llm-wiki/content/sessions/2026/10/18";
  assert.equal(isSessionProcess(`bash ${session}/2110-verify-dev-39124241540-reds/data/metal/tree/apps/infra/metal/gates/ci-multirev-forward-tests.sh`), false);
  assert.equal(isSessionProcess(`python3 ${session}/0900-x/data/test_controls.py`), false);
  assert.equal(isSessionProcess(`node ${session}/0900-x/data/watch.test.mjs`), false);
  assert.equal(isSessionProcess(`python3 ${session}/0900-x/data/watch_proxy.py --act`), true);
  const left = oneOffs([{ name: "posts-backfill-handrun", status: "exited", service: "" }, { name: "virev-prod-remote-gw", status: "running", service: "" },
    { name: "virev-prod-crawler-worker", status: "running", service: "crawler-worker" }], Date.parse("2026-10-18T16:00:00Z"));
  assert.deepEqual(left.map(container => container.name), ["virev-prod-remote-gw"]);
});

// The d3 run at 16:17Z on 10-18: every deploy left virev-prod-copy-oneoff stopped and its owner restarted it by hand. copy-oneoff.sh now
// sets a restart policy and deploy.sh starts it again, so a labelled one-off before its expires_at is not counted; a hand container is.
test("a copy-oneoff.sh one-off with a restart policy before its expires_at is not a hand-run process; an expired or unlabelled one is", () => {
  const now = Date.parse("2026-10-18T16:17:55Z");
  const { containers } = parseBox([
    "C\tvirev-prod-copy-oneoff\trunning|||true|1792348746|on-failure",
    "C\tvirev-prod-old-oneoff\trunning|||true|1792340000|on-failure",
    "C\tvirev-prod-norestart-oneoff\trunning|||true|1792348746|no",
    "C\tposts-backfill-handrun\trunning|||||no",
    "C\tvirev-prod-remote-gw\trunning|remote-gw||||unless-stopped",
  ].join("\n"));
  assert.deepEqual(containers[0], { name: "virev-prod-copy-oneoff", status: "running", service: "", oneoff: { expiresAt: 1792348746, restart: "on-failure" } });
  assert.deepEqual(oneOffs(containers, now).map(container => container.name), ["virev-prod-old-oneoff", "virev-prod-norestart-oneoff", "posts-backfill-handrun"]);
});
