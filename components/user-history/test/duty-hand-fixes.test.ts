import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { UNMEASURED } from "../scripts/duties/estate-reads.ts";
import {
  type AuditRow, type BoardStep, type HandData, type Registry, BOX_SCRIPT, HAND_FIX_WORDS, WRITES, auditSql, classifyConfig, classifyEvent, classifyNote,
  groupAudit, handExecs, isSessionProcess, measure, nextState, oneOffs, parseBox, parseRegistry, report, scriptOf, stepState,
} from "../scripts/duties/hand-fixes.ts";

const NOW = Date.parse("2026-10-14T01:30:00Z");
const DIR = join(import.meta.dirname, "..", "scripts", "duties");
const FILE = join(DIR, "hand-fixes.duty.json");
const registry = async (): Promise<Registry> => parseRegistry(JSON.parse(await readFile(join(DIR, "hand-fixes.faults.json"), "utf8")));
const dutyMetrics = async (): Promise<DutyMetric[]> => parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW).metrics;
let nextId = 1;
const row = (key: string, reason: string, fields: Partial<AuditRow> = {}): AuditRow => ({ id: nextId++, ts: NOW - 3_600_000, actor: "api-key", key, reason, source: "ops-api", ...fields });
const steps = (entries: [string, string][]): Map<string, BoardStep> => new Map(entries.map(([id, status]) => [id, { id, status }]));
const allLive = (): Map<string, BoardStep> => steps([["p97", "doing"], ["p98", "doing"], ["p100", "doing"], ["p77", "doing"]]);
const clean = async (): Promise<HandData> => ({ now: NOW, registry: await registry(), steps: allLive(), notes: [], audit: { prod: [], staging: [] }, events: { prod: [], staging: [] },
  box: { containers: [{ name: "virev-prod-crawler-worker", status: "running", service: "crawler-worker" }], execs: [] }, mac: [], errors: [] });

test("hand fixes: the duty file parses as a daily duty, and the precheck writes every metric key", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW);
  assert.equal(duty.name, "Hand fix designs");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "10:30" });
  assert.equal(duty.precheck.cwd, "../..");
  assert.equal(duty.boardGoal, "p96");
  assert.deepEqual(Object.keys(report(await clean(), duty.metrics).metrics).sort(), duty.metrics.map(metric => metric.key).sort());
});

test("hand fixes: config rows written together count once, and each is skipped, exempt, matched or undesigned", async () => {
  const reg = await registry();
  const abort = Array.from({ length: 23 }, (_, index) => row(`pause.crawl.k${index}`, "watch_proxy abort on production: watch-monitor transport 12% of 626 attempts", { ts: NOW - 1000 }));
  const groups = groupAudit("prod", abort);
  assert.equal(groups.length, 1, "23 pause keys in one abort are one hand fix");
  assert.equal(groups[0]!.keys.length, 23);
  const verdict = (key: string, reason: string, actor = "api-key") => classifyConfig({ actor, keys: [key], text: reason }, reg);
  assert.equal(verdict("pause.crawl", "metal deploy f9f3a0f1c61d: admissions closed", "metal-deploy").kind, "automatic");
  assert.equal(verdict("pause.enrich", "owner: \"can we not enrich for now?\" Crawler ops order: enrichment off").kind, "exempt");
  assert.equal(verdict("search_sync.batch", "C3 write-bytes A/B done: restore the drain batch").kind, "exempt");
  const census = verdict("instagram_census.new_per_minute", "Crawler ops census ladder rung new 2400 -> 2700");
  assert.equal(census.kind === "fault" && census.fault.id, "F1");
  const guard = verdict("pause.tiktok_shop", "TikTok Shop prod watch --act: IO full avg300 8.75 >= 8");
  assert.equal(guard.kind === "fault" && guard.fault.id, "F2", "a reason pattern wins over the key prefix");
  const share = verdict("watch.deep_walk_slot_share", "Watchlist duty: prod collab lane full at 190 claims");
  assert.equal(share.kind === "fault" && share.fault.id, "F4");
  assert.equal(verdict("brand_new.knob", "set by hand").kind, "undesigned");
});

test("hand fixes: engage status writes and board notes count only when a fault or the hand-fix words name them", async () => {
  const reg = await registry();
  const thaw = classifyEvent({ accountId: 31, at: NOW, outcome: "active", errorCode: "" }, reg);
  assert.equal(thaw?.kind === "fault" && thaw.fault.id, "F5");
  assert.equal(classifyEvent({ accountId: 75, at: NOW, outcome: "parked", errorCode: "" }, reg), null, "a park is the product's own status write");
  assert.equal(classifyNote({ id: "s1", at: NOW, text: "prod Watchlist is 85.2% green" }, reg), null);
  const writer = classifyNote({ id: "s164", at: NOW, text: "both writers alive (supervised 3537013 and hand-started 3502926)" }, reg);
  assert.equal(writer?.kind === "fault" && writer.fault.id, "F3");
  const ci = classifyNote({ id: "s150", at: NOW, text: "41 runs are ghosts; ours are re-pushed fresh by their jobs" }, reg);
  assert.equal(ci?.kind === "fault" && ci.fault.id, "F6");
  assert.equal(classifyNote({ id: "s9", at: NOW, text: "metal restarted the signer by hand" }, reg)?.kind, "undesigned");
  assert.equal(classifyNote({ id: "s10", at: NOW, text: "Durable software: every fault we fixed by hand becomes a design" }, reg)?.kind, "exempt");
  assert.ok(HAND_FIX_WORDS.test("Check now on 5,752 rows"));
});

test("hand fixes: a fault whose design step is done turns its hand fixes into repeats; no step means no job", async () => {
  const reg = await registry();
  const f4 = reg.faults.find(fault => fault.id === "F4")!;
  const f1 = reg.faults.find(fault => fault.id === "F1")!;
  assert.equal(stepState(f4, steps([["p97", "doing"]])), "live");
  assert.equal(stepState(f4, steps([["p97", "done"]])), "done");
  assert.equal(stepState(f4, steps([["p97", "dropped"]])), "none");
  assert.equal(stepState(f1, steps([])), "none");
  const metrics = await dutyMetrics();
  const data = await clean();
  data.steps = steps([["p97", "done"], ["p98", "doing"], ["p100", "doing"], ["p77", "doing"]]);
  data.audit.prod = [row("watch.deep_walk_slot_share", "share 50 -> 20 by hand")];
  const output = report(data, metrics);
  assert.equal(output.metrics.repeats_after_design, 1);
  assert.equal(output.metrics.undesigned_hand_fixes, 0);
  assert.equal(output.metrics.faults_without_job, reg.faults.filter(fault => !fault.board_step).length);
  assert.ok(output.flagged!.some(slice => slice.kind === "repeat" && slice.item === "p97"));
  assert.equal(judge(metrics, output).verdict, "missed");
});

test("hand fixes: the box read finds a docker exec writer and one-off containers, and skips psql in data stores", () => {
  const writer = JSON.stringify({ Running: true, ProcessConfig: { entrypoint: "sh", arguments: ["-c", "exec dotenvx-start.sh uv run --no-sync python -m src.run.run acquisition-writer"] } });
  const psql = JSON.stringify({ Running: true, ProcessConfig: { entrypoint: "psql", arguments: ["-U", "owner_ro"] } });
  const done = JSON.stringify({ Running: false, ProcessConfig: { entrypoint: "sh", arguments: ["-c", "true"] } });
  const piped = JSON.stringify({ Running: true, ProcessConfig: { entrypoint: "dotenvx-start.sh", arguments: [".venv/bin/python", "-"] } });
  const box = parseBox([
    "C\tvirev-prod-crawler-worker\trunning|crawler-worker|ef646f22 aa11",
    `E\tvirev-prod-crawler-worker\t${writer}`,
    `E\tvirev-prod-crawler-worker\t${done}`,
    `E\tvirev-prod-crawler-worker\t${piped}`,
    "C\tvirev-prod-postgres\trunning|postgres|bb22",
    `E\tvirev-prod-postgres\t${psql}`,
    "C\tvirev-staging-copy-oneoff\texited||",
    "C\tprod-pg-basebackup\texited||",
  ].join("\n"));
  assert.equal(box.containers.length, 4);
  assert.deepEqual(handExecs(box.execs).map(exec => exec.container), ["virev-prod-crawler-worker"]);
  assert.match(handExecs(box.execs)[0]!.command, /acquisition-writer/);
  assert.deepEqual(oneOffs(box.containers).map(container => container.name), ["virev-staging-copy-oneoff", "prod-pg-basebackup"]);
  assert.match(BOX_SCRIPT, /ExecIDs/);
});

test("hand fixes: session processes are found by folder, and a script counts when it writes control state", () => {
  const guard = "/opt/homebrew/bin/python3 apps/llm-wiki/content/sessions/2026/10/12/1934-census-canary-rerun/data/census_guard_v24.py";
  assert.ok(isSessionProcess(guard));
  assert.equal(scriptOf(guard), "apps/llm-wiki/content/sessions/2026/10/12/1934-census-canary-rerun/data/census_guard_v24.py");
  assert.ok(!isSessionProcess("/bin/bash -c exec 9>&0 python3 apps/llm-wiki/content/sessions/2026/10/01/x/data/monitor/census_watch5.py"), "the shell wrapper is not counted twice");
  assert.ok(!isSessionProcess("tar -x -C /Users/x/apps/llm-wiki/content/sessions/2026/10/14/0146-collab-claim-split/src"));
  assert.ok(WRITES.test("UPDATE config SET value='true', updated_at=now() WHERE key='PKEY'"));
  assert.ok(WRITES.test("await set_controls(s, values, actor=\"tiktok-shop-thread\")"));
  assert.ok(WRITES.test("curl -X POST http://localhost:8787/ops/controls"));
  assert.ok(!WRITES.test("get(a.tier, k, \"/ops/proxy-bytes\")"), "a read of /ops is not a write");
});

test("hand fixes: a failed source is a miss and keeps its read mark; the first run reads the last 24 h", async () => {
  const metrics = await dutyMetrics();
  const data = await clean();
  delete data.box;
  data.errors.push({ source: "box", message: "ssh exit 255" });
  const output = report(data, metrics);
  assert.equal(output.metrics.unsupervised_box_processes, UNMEASURED);
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(judge(metrics, output).verdict, "missed");
  assert.match(auditSql(undefined, NOW), /ts >= to_timestamp\(1791855000\)/);
  assert.match(auditSql(12752, NOW), /id > 12752/);
  const partial: HandData = { ...(await clean()), audit: { prod: [row("pause.media", "x", { id: 900 })] }, events: {} };
  const state = nextState({ audit: { prod: 800, staging: 14212 }, events: { staging: NOW - 5 } }, partial);
  assert.deepEqual(state.audit, { prod: 900, staging: 14212 }, "staging config failed, so its mark stays");
  assert.equal(state.events?.staging, NOW - 5);
});

test("hand fixes: measure reads every source through its deps, and no Grafana login fails the four Postgres reads", async () => {
  const data = await measure({ now: NOW, state: {}, query: null, authError: "GRAFANA_ADMIN_PASSWORD is missing",
    registry: async () => JSON.parse(await readFile(join(DIR, "hand-fixes.faults.json"), "utf8")),
    board: async () => ({ plan: [{ id: "p96", status: "doing", children: [{ id: "p97", status: "doing" }] }], scratch: [{ id: "s1", text: "thawed 31 by hand", at: new Date(NOW - 1000).toISOString() }, { id: "s0", text: "old", at: "2026-10-01T00:00:00Z" }] }),
    box: async () => "C\tvirev-prod-crawler-worker\trunning|crawler-worker|",
    mac: async () => [] });
  assert.deepEqual(data.errors.map(error => error.source).sort(), ["grafana auth", "prod config", "prod engage", "staging config", "staging engage"]);
  assert.equal(data.steps?.get("p97")?.status, "doing");
  assert.deepEqual(data.notes?.map(note => note.id), ["s1"], "a note older than 24 h is not read on the first run");
  const output = report(data, await dutyMetrics());
  assert.equal(output.metrics.undesigned_hand_fixes, UNMEASURED);
  assert.equal(output.metrics.session_loops_writing, 0);
});
