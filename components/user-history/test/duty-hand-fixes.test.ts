import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { UNMEASURED } from "../scripts/duties/estate-reads.ts";
import {
  type AuditRow, type HandData, type RefState, type Registry, BOX_SCRIPT, WRITES, auditSql, classifyConfig, classifyEvent,
  groupAudit, handExecs, isSessionProcess, measure, nextState, oneOffs, parseBox, parseRegistry, report, scriptOf, stepRefs, stepState,
} from "../scripts/duties/hand-fixes.ts";

const NOW = Date.parse("2026-10-14T01:30:00Z");
const DIR = join(import.meta.dirname, "..", "scripts", "duties");
const FILE = join(DIR, "hand-fixes.duty.json");
const registry = async (): Promise<Registry> => parseRegistry(JSON.parse(await readFile(join(DIR, "hand-fixes.faults.json"), "utf8")));
const dutyMetrics = async (): Promise<DutyMetric[]> => parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW).metrics;
let nextId = 1;
const row = (key: string, reason: string, fields: Partial<AuditRow> = {}): AuditRow => ({ id: nextId++, ts: NOW - 3_600_000, actor: "api-key", key, reason, source: "ops-api", ...fields });
const steps = (entries: [string, string | null][]): Map<string, RefState> => new Map(entries.map(([ref, status]) => [ref, { kind: "step", status }]));
const allLive = (): Map<string, RefState> => steps([["p97", "doing"], ["p98", "doing"], ["p100", "doing"], ["p77", "doing"]]);
const clean = async (): Promise<HandData> => ({ now: NOW, registry: await registry(), refs: allLive(), audit: { prod: [], staging: [] }, events: { prod: [], staging: [] },
  box: { containers: [{ name: "virev-prod-crawler-worker", status: "running", service: "crawler-worker" }], execs: [] }, mac: [], errors: [] });

test("hand fixes: the duty file has one headline and 3 more metrics, and the precheck writes them plus the detail counts", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW);
  assert.equal(duty.name, "Hand fix designs");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "10:30" });
  assert.equal(duty.precheck.cwd, "../..");
  assert.equal(duty.boardGoal, "p96");
  assert.deepEqual(duty.metrics.map(metric => [metric.key, metric.headline ?? false]),
    [["faults_without_job", true], ["repeats_after_design", false], ["undesigned_hand_fixes", false], ["hand_run_processes", false]]);
  assert.deepEqual(Object.keys(report(await clean(), duty.metrics).metrics).sort(),
    [...duty.metrics.map(metric => metric.key), "session_loops_writing", "unsupervised_box_processes", "source_errors"].sort());
});

test("hand fixes: hand_run_processes adds the session loops and the box processes, and both stay in the detail", async () => {
  const metrics = await dutyMetrics();
  const data = await clean();
  data.mac = [{ pid: 7, command: "python3 guard.py", script: "guard.py", writes: true }, { pid: 8, command: "python3 read.py", script: "read.py", writes: false }];
  data.box = { containers: [...data.box!.containers, { name: "virev-staging-copy-oneoff", status: "exited", service: "" }],
    execs: [{ container: "virev-prod-crawler-worker", service: "crawler-worker", running: true, command: "sh -c exec dotenvx-start.sh uv run python -m src.run.run acquisition-writer" }] };
  const output = report(data, metrics);
  assert.deepEqual([output.metrics.hand_run_processes, output.metrics.session_loops_writing, output.metrics.unsupervised_box_processes], [3, 1, 2]);
  assert.deepEqual(output.flagged!.map(slice => slice.kind).filter(kind => ["session_loops", "box_exec", "box_oneoff"].includes(kind)), ["session_loops", "box_exec", "box_oneoff"]);
  const result = judge(metrics, output);
  assert.equal(result.verdict, "missed");
  assert.ok(!("session_loops_writing" in result.metrics), "the server judges only the 4 duty metrics");
});

test("hand fixes: an unread registry or board misses the headline and keeps its source_error flag", async () => {
  const metrics = await dutyMetrics();
  const data = await clean();
  delete data.registry;
  data.errors.push({ source: "registry", message: "hand-fixes.faults.json: Unexpected token" });
  const output = report(data, metrics);
  assert.equal(output.metrics.faults_without_job, UNMEASURED);
  assert.equal(output.metrics.hand_run_processes, 0, "the box and the Mac were read");
  assert.ok(output.flagged!.some(slice => slice.kind === "source_error" && /^registry:/.test(slice.excerpt)));
  assert.match(judge(metrics, output).summary, /faults_without_job/);
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

test("hand fixes: engage status writes count only when a fault names them", async () => {
  const reg = await registry();
  const thaw = classifyEvent({ accountId: 31, at: NOW, outcome: "active", errorCode: "" }, reg);
  assert.equal(thaw?.kind === "fault" && thaw.fault.id, "F5");
  assert.equal(classifyEvent({ accountId: 75, at: NOW, outcome: "parked", errorCode: "" }, reg), null, "a park is the product's own status write");
});

test("hand fixes: a fault whose design steps are all done turns its hand fixes into repeats; no live ref means no job", async () => {
  const reg = await registry();
  const f4 = reg.faults.find(fault => fault.id === "F4")!;
  const f8 = reg.faults.find(fault => fault.id === "F8")!;
  assert.deepEqual(f8.designs, ["commit:477ed1034f", "commit:699c919215", "p90"]);
  assert.equal(stepState(f4, steps([["p97", "doing"]])), "live");
  assert.equal(stepState(f4, steps([["p97", "done"]])), "done");
  assert.equal(stepState(f4, steps([["p97", "dropped"]])), "none");
  assert.equal(stepState(f4, steps([["p97", null]])), "none", "a step missing from its board is no job");
  const git = (exists: boolean): RefState => ({ kind: "git", exists });
  assert.equal(stepState(f8, new Map([["commit:477ed1034f", git(true)], ["commit:699c919215", git(true)], ["p90", { kind: "step", status: "done" }]])), "done");
  assert.equal(stepState(f8, new Map([["commit:477ed1034f", git(true)], ["p90", { kind: "step", status: null }]])), "live", "a commit that exists keeps the design live");
  const box = { id: "F2", title: "t", owner: "metal", match: {}, designs: ["branch:sieun/box-selfheal"] };
  assert.equal(stepState(box, new Map([["branch:sieun/box-selfheal", git(false)]])), "none");
  const other = "01a115e2-9544-7204-b8db-8ce4d5319048";
  const refs = stepRefs(reg.faults, new Map([["01a11bd7-072f-7591-ad1d-f123c276cde5", new Map([["p97", { id: "p97", status: "doing" }]])], [other, new Map([["p170", { id: "p170", status: "done" }]])]]));
  assert.deepEqual(refs.get("p97"), { kind: "step", status: "doing" });
  assert.deepEqual(refs.get(`${other}/p170`), { kind: "step", status: "done" });
  assert.deepEqual(refs.get(`${other}/p171`), { kind: "step", status: null });
  assert.ok(!refs.has("branch:sieun/box-selfheal"), "git refs are read by measure, not from boards");
  const metrics = await dutyMetrics();
  const data = await clean();
  data.refs = steps([["p97", "done"], ["p98", "doing"], ["p100", "doing"], ["p77", "doing"]]);
  data.audit.prod = [row("watch.deep_walk_slot_share", "share 50 -> 20 by hand")];
  const output = report(data, metrics);
  assert.equal(output.metrics.repeats_after_design, 1);
  assert.equal(output.metrics.undesigned_hand_fixes, 0);
  assert.equal(output.metrics.faults_without_job, reg.faults.filter(fault => !fault.designs.some(ref => ["p97", "p98", "p100", "p77"].includes(ref))).length);
  assert.ok(output.flagged!.some(slice => slice.kind === "repeat" && slice.item === "p97"));
  assert.equal(judge(metrics, output).verdict, "missed");
  assert.throws(() => parseRegistry({ ...reg, faults: [{ ...f4, designs: ["lane rate controller"] }] }), /design ref/);
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
  assert.equal(output.metrics.hand_run_processes, UNMEASURED);
  assert.ok(!("unsupervised_box_processes" in output.metrics), "an unread box has no detail count");
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
    board: async chat => chat === "01a11bd7-072f-7591-ad1d-f123c276cde5"
      ? { plan: [{ id: "p96", status: "doing", children: [{ id: "p97", status: "doing" }] }] }
      : { plan: [{ id: "p170", status: "doing" }] },
    gitRef: async ref => ref === "branch:sieun/box-selfheal",
    box: async () => "C\tvirev-prod-crawler-worker\trunning|crawler-worker|",
    mac: async () => [] });
  assert.deepEqual(data.errors.map(error => error.source).sort(), ["grafana auth", "prod config", "prod engage", "staging config", "staging engage"]);
  assert.deepEqual(data.refs?.get("p97"), { kind: "step", status: "doing" });
  assert.deepEqual(data.refs?.get("01a115e2-9544-7204-b8db-8ce4d5319048/p170"), { kind: "step", status: "doing" });
  assert.deepEqual(data.refs?.get("branch:sieun/box-selfheal"), { kind: "git", exists: true });
  assert.deepEqual(data.refs?.get("commit:477ed1034f"), { kind: "git", exists: false });
  const output = report(data, await dutyMetrics());
  assert.equal(output.metrics.undesigned_hand_fixes, UNMEASURED);
  assert.equal(output.metrics.session_loops_writing, 0);
  assert.equal(output.metrics.hand_run_processes, 0);
});

test("hand fixes: a fix before a fault's done_at is no repeat, and the 10-14 misses map to faults or the owner-order exemption", async () => {
  const reg = await registry();
  const verdict = (key: string, reason: string) => classifyConfig({ actor: "api-key", keys: [key], text: reason }, reg);
  assert.equal(verdict("proxy_endpoints.anonymous_country", "Owner order 10-14 about 09:15Z: GeoNode calls never ask for a country (c71).").kind, "exempt");
  const kafka = verdict("kafka.topic.media.fetch.retention.bytes", "metal 01a11d24: prod media.fetch fullest partition 813 MB of 1 GiB");
  assert.equal(kafka.kind === "fault" && kafka.fault.id, "F13");
  const mirror = verdict("media.mirror_kinds", "revert 10:1xZ change: fix the live refresh instead (Crawler ops)");
  assert.equal(mirror.kind === "fault" && mirror.fault.id, "F14");
  const f4 = reg.faults.find(fault => fault.id === "F4")!;
  const metrics = await dutyMetrics();
  const data = await clean();
  data.registry = { ...reg, faults: [{ ...f4, done_at: new Date(NOW).toISOString() }] };
  data.refs = steps([["p97", "done"]]);
  data.audit.prod = [row("watch.deep_walk_slot_share", "share 50 -> 20 by hand", { ts: NOW - 60_000 }), row("watch.deep_walk_slot_share", "share 20 -> 10 by hand", { ts: NOW + 60_000 })];
  const output = report(data, metrics);
  assert.equal(output.metrics.repeats_after_design, 1, "only the change after done_at is a repeat");
  assert.throws(() => parseRegistry({ ...reg, faults: [{ ...f4, done_at: "yesterday" }] }), /done_at/);
});

test("hand fixes: a declared box unit's exec is exempt, while a hand-started writer still counts", async () => {
  const reg = await registry();
  const exec = (command: string) => ({ container: "virev-staging-crawler-api", service: "crawler-api", running: true, command });
  const inventory = exec('sh -c cd /app/apps/crawler-v3 && nice -n 10 dotenvx run -q -f "$DOTENV_FILE" -- .venv/bin/python - 3600 8');
  const writer = exec("sh -c exec dotenvx-start.sh uv run --no-sync python -m src.run.run acquisition-writer > /tmp/acq-writer-2.log 2>&1");
  assert.deepEqual(handExecs([inventory, writer], reg.exempt.box_exec_regex), [writer]);
  assert.deepEqual(handExecs([inventory, writer]), [inventory, writer]);
  assert.ok(reg.faults.find(fault => fault.id === "F2")!.designs.includes("commit:98c14dbd1a"));
});
