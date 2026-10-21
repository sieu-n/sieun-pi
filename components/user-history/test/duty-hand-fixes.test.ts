// Guards the d3 false repeat of 10-18: audit 13533 (10-16 05:08Z) raised census rates, said "no box stop since 00:40Z", and read as an F2 repeat 48 h later.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { type AuditRow, type Deploy, type Fault, type HandData, type RefState, auditSql, classifyConfig, designOnProd, gitReleaseHolds, groupAudit, handExecs, isSessionProcess, nextState, hostWriters, oneOffs, parseBox, parseRegistry, releaseAt, report, WRITES, HOST_WRITES } from "../scripts/duties/hand-fixes.ts";

const DIR = join(import.meta.dirname, "..", "scripts", "duties");
const AT = Date.parse("2026-10-16T05:08:27Z");
const REASON = "Climb for p71: 160 gave 5,400-5,850 census ok/min (03:15-04:45Z) against 4,550-4,900 at 128, TikTok Shop -2%, engage -5%, writer lag under line, " +
  "no box stop since 00:40Z. cc 160 -> 192, new 13500 -> 16000; judged at about 05:40Z on all lanes' good results per hour. Go 2026-10-16 05:08Z.";
const rows = (ts: number): AuditRow[] => [13533, 13534].map((id, index) => ({ id, ts, actor: "api-key", source: "ops-api", reason: REASON,
  key: index ? "instagram_census.new_per_minute" : "instagram_census.crawl_concurrency" }));
const registry = async () => parseRegistry(JSON.parse(await readFile(join(DIR, "hand-fixes.faults.json"), "utf8")));
const refs = (): Map<string, RefState> => new Map([["01a115e2-9544-7204-b8db-8ce4d5319048/p173", { kind: "step", status: "done" }],
  ["01a115e2-9544-7204-b8db-8ce4d5319048/p170", { kind: "step", status: "doing" }]]);
// Prod ran a8f85b420699 from 10-15 10:24:30Z, and it holds F2's box stop commit 98c14dbd1a (checked with gitReleaseHolds on 10-18).
const data = async (now: number, prod: AuditRow[]): Promise<HandData> => ({ now, registry: await registry(), refs: refs(), audit: { prod, staging: [] }, events: {}, errors: [],
  deploys: [{ at: Date.parse("2026-10-15T10:24:30Z"), release: "a8f85b420699" }], held: new Map([["a8f85b420699", new Set(["commit:98c14dbd1a"])]]) });
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
  const exempted = { ...second, registry: { ...second.registry!, exempt: { ...second.registry!.exempt, config_reason_regex: "^raise the new knob$" } } };
  assert.deepEqual(nextState(state, exempted).filed, []);
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

// The d3 read at 01:10Z on 10-21: the crawler prod read-backs' ro.py counted as 2 writers because it names /ops/controls, though it only
// sends GET there and POSTs Grafana ds/query reads. The lines below are ro.py's own.
test("a script that only reads /ops/controls is not a writer; a POST, PUT or PATCH there is", () => {
  const ro = [
    '"""Crawler controls go through GET /ops/controls on the crawler API."""',
    "def http(method, url, headers, body=None):",
    "    req = urllib.request.Request(url, data=data, method=method,",
    '    status, res = http("POST", GRAFANA, {"authorization": f"Bearer {secret(\'GRAFANA_AGENT_TOKEN\')}"},',
    '                       {"queries": [{"refId": "A", **query}], "from": str(now - 3600_000), "to": str(now)})',
    "def ops(env, method, path, body=None, tier=None):",
    '    return http(method, f"{host}/ops{path}", headers, body)',
    '    status, d = ops(env, "GET", "/controls")',
    '        raise SystemExit(f"/ops/controls {env}: HTTP {status}")',
  ].join("\n");
  assert.equal(WRITES.test(ro), false);
  assert.equal(HOST_WRITES.test(ro), false);
  for (const write of [
    'r = requests.post(f"{API}/ops/controls", headers=H, json={"values": {"proxy.connect_racers": v}, "reason": why}, timeout=60)',
    'r = httpx.patch(\n    f"{API}/ops/config", json=body)',
    "curl -s -X POST -H @key https://crawler.virev.ai/ops/controls -d @body.json",
    'status, d = ops(env, "POST", "/controls", {"values": v})',
    'urllib.request.Request(f"{API}/ops/controls", data=b, method="PUT")',
  ]) assert.equal(WRITES.test(`${ro}\n${write}`), true, write);
});

// The d3 read at 14:40Z on 10-20: a read-only stdin script with arguments counted as the one hand writer left.
test("a stdin script with arguments is a session tool, not a hand-run exec", () => {
  const exec = (command: string) => ({ container: "virev-prod-crawler-worker", service: "crawler-worker", running: true, command, lasted: true });
  const reads = [exec("dotenvx-start.sh .venv/bin/python - 2026-10-20T14:06:00+00:00/2026-10-20T14:14:00+00:00"), exec("dotenvx-start.sh .venv/bin/python -"),
    exec("bash -s"), exec("/bin/sh -s x")];
  const writer = exec("sh -c dotenvx-start.sh /app/apps/crawler-v3/.venv/bin/python /tmp/mw_extra_writer.py >> /tmp/mw_extra_writer.1.log 2>&1");
  const flagged = exec("/app/apps/crawler-v3/.venv/bin/python -m src.run.run tiktok-shop-writer");
  assert.deepEqual(handExecs([...reads, writer, flagged]), [writer, flagged]);
});

// Guards the d3 run after promote 12 on 10-18: the CI reds job's gate script copy read as 3 session writers, and an exited container as a hand-run one.
test("a CI gate or test script in a session folder and an exited container are not hand-run processes", () => {
  const session = "/home/sieun/Documents/Github/auto-sns-agent/apps/llm-wiki/content/sessions/2026/10/18";
  assert.equal(isSessionProcess(`bash ${session}/2110-verify-dev-39124241540-reds/data/metal/tree/apps/infra/metal/gates/ci-multirev-forward-tests.sh`), false);
  assert.equal(isSessionProcess(`python3 ${session}/0900-x/data/test_controls.py`), false);
  assert.equal(isSessionProcess(`node ${session}/0900-x/data/watch.test.mjs`), false);
  assert.equal(isSessionProcess(`python3 ${session}/0900-x/data/watch_proxy.py --act`), true);
  // 21:04Z on 10-18 the census guard read as 2 writers, its python and the /usr/bin/sh -c that started it.
  assert.equal(isSessionProcess(`/usr/bin/sh -c python ${session}/1934-x/data/profile_guard.py x.log > x.out 2>&1`), false);
  // 13:10Z on 10-20 three prod writers under ~/work ran as systemd-run units and read as 0.
  assert.equal(isSessionProcess("/home/sieun/.prime/agent/kernel-venv/bin/python /home/sieun/work/geonode-port-drop/racers_guard.py /home/sieun/work/geonode-port-drop/racers_guard.log"), true);
  assert.equal(isSessionProcess("python3 /home/sieun/scratch/01a1/rig/watch.py"), true);
  assert.equal(isSessionProcess("/usr/bin/sh -c python /home/sieun/work/census-canary/hold_renew.py x.log > x.out 2>&1"), false);
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

// The d3 run at 17:2xZ on 10-18 read 18 while us-metal01 also ran 7 loops that ssh sessions had left behind, which the docker exec read never
// saw: the census, Meta Ads and TikTok Shop watchers that start the /tmp writers again after a restart, and two Meta Ads walk UPDATE loops.
test("a box process an ssh session left behind counts when its script writes, and a read-only probe does not", () => {
  const line = (pid: number, command: string, text: string) => `H\t${pid}\t${Buffer.from(JSON.stringify({ command, text })).toString("base64")}`;
  const { hosts } = parseBox([
    line(433386, "/bin/bash /root/meta-ads-ops/defer_future_windows_loop.sh", "psql -c \"UPDATE meta_ads_walks SET next_run_at = now()\""),
    line(3577784, "/bin/bash /root/census-writer-ops/census_writers_watch.sh", "docker exec -d -w /app virev-prod-crawler-worker sh -c python /tmp/cw_extra_writer.py"),
    line(1589822, "bash /root/ig-census-bio-seed-20261018.sh", "urllib.request.Request(\"http://127.0.0.1:8787/ops/census/instagram/seed\")"),
    line(1636679, "bash apiprobe.sh 60", "curl -s http://127.0.0.1:8787/health"),
  ].join("\n"));
  assert.equal(hosts.length, 4);
  assert.deepEqual(hostWriters(hosts).map(host => host.pid), [433386, 3577784, 1589822]);
  // 10-19 17:28Z: the staging deploy that CI runs as virev-deploy-staging is the deploy path, not a hand loop.
  const deploy = parseBox(line(2789780, `/usr/bin/bash /srv/staging/releases/${"0".repeat(40)}/apps/infra/metal/deploy.sh staging x`, "docker exec -d x; pkill y")).hosts;
  assert.deepEqual(hostWriters(deploy), []);
});

// Guards the d3 run of 10-18 17:18Z: F18 had no done_at, so its done step p146 dated the design from the start and audit 14032 (06:04Z, off
// "until land 38 is on prod") read as a repeat, though e0d09f5a42 reached prod only at 12:31:13Z in 43490e7e9f (promote 12).
const F18_REFS = (): Map<string, RefState> => new Map([["01a11bd7-072f-7591-ad1d-f123c276cde5/p146", { kind: "step", status: "done" }],
  ["01a115e2-9544-7204-b8db-8ce4d5319048/p700", { kind: "step", status: "done" }], ["commit:e0d09f5a42", { kind: "git", exists: true }], ["commit:0123456789", { kind: "git", exists: true }]]);
const DEPLOYS: Deploy[] = [{ at: Date.parse("2026-10-15T10:24:30Z"), release: "a8f85b420699" }, { at: Date.parse("2026-10-18T12:31:13Z"), release: "43490e7e9f94" }];
const SUPPLY = [hand(14032, Date.parse("2026-10-18T06:04:20Z"), "supply_hold.enabled", "Crawler ops 06:0xZ (c72): Off until land 38 is on prod."),
  hand(14098, Date.parse("2026-10-18T12:33:34Z"), "supply_hold.enabled", "Crawler ops 12:3xZ: land 38 on prod since 12:31:13Z. supply_hold.enabled false -> true.")];
const f18 = async (change: Partial<Fault>, extra: Partial<HandData> = {}): Promise<HandData> => {
  const reg = await registry();
  const undated = ({ done_at: _, ...fault }: Fault): Fault => fault;
  const faults = reg.faults.map(fault => fault.id === "F18" ? { ...undated(fault), ...change } : fault);
  return { now: Date.parse("2026-10-18T17:18:11Z"), registry: { ...reg, faults }, refs: F18_REFS(), audit: { prod: SUPPLY, staging: [] }, events: {}, errors: [], ...extra };
};
const HELD = new Map([["a8f85b420699", new Set<string>()], ["43490e7e9f94", new Set(["commit:e0d09f5a42"])]]);

test("a commit design ships when prod first runs a release that holds it: audit 14032 before it is no repeat, audit 14098 after it is one", async () => {
  const data = await f18({ designs: ["01a11bd7-072f-7591-ad1d-f123c276cde5/p146", "commit:e0d09f5a42"] }, { deploys: DEPLOYS, held: HELD });
  const output = report(data, await metrics(data.now));
  assert.equal(output.metrics.repeats_after_design, 1);
  assert.deepEqual(output.flagged!.filter(slice => slice.kind === "repeat").map(slice => /audit (\d+)/.exec(slice.excerpt)![1]), ["14098"]);
  const fault = data.registry!.faults.find(item => item.id === "F18")!;
  assert.equal(designOnProd(fault, SUPPLY[0]!.ts, DEPLOYS, HELD), "not_live");
  assert.equal(designOnProd(fault, SUPPLY[1]!.ts, DEPLOYS, HELD), "live");
  const restore = classifyConfig({ actor: "rate-controller", writer: "hold-expiry", keys: ["supply_hold.enabled"], text: "guard off ended: supply_hold.enabled" }, data.registry!);
  assert.equal(restore.kind, "automatic");
});

test("a design commit that no prod release holds yet makes no repeat and is flagged as not on prod", async () => {
  const data = await f18({ designs: ["01a11bd7-072f-7591-ad1d-f123c276cde5/p146", "commit:e0d09f5a42", "commit:0123456789"] }, { deploys: DEPLOYS, held: HELD });
  const output = report(data, await metrics(data.now));
  assert.equal(output.metrics.repeats_after_design, 0);
  assert.match(output.flagged!.find(slice => slice.kind === "design_not_on_prod")!.excerpt, /F18 commit:e0d09f5a42 commit:0123456789/);
});

test("with no deploy read a commit design falls back to done_at, and with no done_at either repeats_after_design is a miss", async () => {
  const designs = ["01a11bd7-072f-7591-ad1d-f123c276cde5/p146", "commit:e0d09f5a42"];
  const blind = await f18({ designs });
  const missed = report(blind, await metrics(blind.now));
  assert.ok(missed.metrics.repeats_after_design! > 0 && missed.flagged!.some(slice => slice.kind === "unmeasured"));
  assert.match(missed.flagged!.find(slice => slice.kind === "source_error")!.excerpt, /^prod deploys: F18 /);
  const dated = await f18({ designs, done_at: "2026-10-18T12:31:13Z" });
  assert.equal(report(dated, await metrics(dated.now)).metrics.repeats_after_design, 1);
});

test("the box read lists each ok prod deploy from deploy.log, and a release holds a commit by its tree's pinned tip or a Replayed-From trailer", async () => {
  const { deploys } = parseBox(["D\t2026-10-15T10:24:30Z\ta8f85b420699", "D\t2026-10-18T12:31:13Z\t43490e7e9f94", "D\tnot-a-time\tabc"].join("\n"));
  assert.deepEqual(deploys, DEPLOYS);
  assert.equal(releaseAt(DEPLOYS, Date.parse("2026-10-18T12:31:12Z"))!.release, "a8f85b420699");
  const ancestors: Record<string, string[]> = { land38: ["land37"], pin: ["e0d09f5a42", "replay"] };
  const git = async (args: string[]): Promise<string> => {
    if (args[0] === "log" && args[1] === "--all") return "land38 T38\npin T38\nland37 T37\n";
    if (args[0] === "rev-parse") { const [ref, kind] = args[2]!.split("^"); return `${kind === "{tree}" ? "T38" : ref}\n`; }
    if (args[0] === "merge-base") { if (ancestors[args[3]!]?.includes(args[2]!)) return ""; throw new Error("exit 1"); }
    if (args[0] === "log") return args.at(-1) === "pin" && args.includes("--grep=Replayed-From: object") ? "replay\n" : "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const holds = gitReleaseHolds(git);
  assert.equal(await holds("land38", "e0d09f5a42"), true);
  assert.equal(await holds("land38", "object"), true);
  assert.equal(await holds("land38", "other"), false);
});

// Guards the d3 read of 10-19 15:35Z: the Crawler VP closed F1's p170 at 15:15Z, and repeats_after_design read 588, every F1 row of the day
// before it, 544 of them the prod lane rate controller's own writes.
const P170 = "01a115e2-9544-7204-b8db-8ce4d5319048/p170";
const CLOSED = Date.parse("2026-10-19T15:15:00Z");
const controller = (id: number, ts: number): AuditRow => ({ id, ts, actor: "rate-controller", source: "rate-controller", key: "tiktok_shop.crawl_concurrency",
  reason: "tiktok_shop climb: tiktok_shop.crawl_concurrency 320 -> 384" });

test("the lane rate controller's writes are F1's design at work, not hand fixes", async () => {
  assert.equal(classifyConfig(groupAudit("prod", [controller(14850, CLOSED + 60_000)])[0]!, await registry()).kind, "automatic");
});

test("a closed step-only fault with no done_at counts no hand fix from before the run that first read its steps done", async () => {
  const reg = await registry();
  const undated = { ...reg, faults: reg.faults.map(({ done_at: _, ...fault }) => fault) };
  const closed = new Map([...refs(), [P170, { kind: "step", status: "done" } as RefState]]);
  const before = hand(14858, CLOSED - 3_600_000, "instagram_census.crawl_concurrency", "Load-shed test, step 1 of 3");
  const first = { ...(await data(CLOSED + 600_000, [before])), registry: undated, refs: closed };
  assert.equal(report(first, await metrics(first.now)).metrics.repeats_after_design, 0);
  const seen = nextState({}, first).doneSeen!;
  assert.equal(seen.F1, first.now);
  const later = hand(14867, first.now + 600_000, "instagram_census.crawl_concurrency", "Load-shed test, step 3 of 3");
  const second = { ...first, now: first.now + 1_200_000, audit: { prod: [before, later], staging: [] }, doneSeen: seen };
  assert.equal(report(second, await metrics(second.now)).metrics.repeats_after_design, 1);
});

test("F1 is dated by p170's close, so only the hand writes after 15:15Z on 10-19 are repeats", async () => {
  const closed = new Map([...refs(), [P170, { kind: "step", status: "done" } as RefState]]);
  const now = CLOSED + 1_800_000;
  const prod = [hand(14858, CLOSED - 600_000, "instagram_census.crawl_concurrency", "Load-shed test, step 1 of 3"),
    hand(14867, CLOSED + 900_000, "instagram_census.crawl_concurrency", "Load-shed test, step 3 of 3"), controller(14870, CLOSED + 1_000_000)];
  assert.equal(report({ ...(await data(now, prod)), refs: closed }, await metrics(now)).metrics.repeats_after_design, 1);
});

// 10-19 15:59Z: tblspc-bench, p438-sig-new and p438-sig-head ran on the default bridge, where no prod or staging store resolves, and
// counted as 3 hand-run containers plus 1 psql exec. A container on virev-prod still counts.
test("a container or exec on no prod or staging network is not a hand-run writer", () => {
  const { containers, execs } = parseBox([
    "C\ttblspc-bench\trunning|||||no|bridge,",
    "C\tvirev-prod-tiktok-signer-hand-1\trunning|||||unless-stopped|virev-prod,",
    "C\told-read\trunning|||||no",
    `E\ttblspc-bench\t${JSON.stringify({ Running: true, ProcessConfig: { entrypoint: "psql", arguments: ["-c", "alter table t"] } })}`,
  ].join("\n"));
  assert.deepEqual(oneOffs(containers, Date.parse("2026-10-19T16:00:00Z")).map(container => container.name), ["virev-prod-tiktok-signer-hand-1", "old-read"]);
  assert.deepEqual(handExecs(execs), []);
});

// 10-19 19:50Z: a one-shot read-only ClickHouse query run through docker exec in crawler-api counted as a hand writer. An exec counts only
// when it still runs at the read's second sample; a read with no second sample counts every running exec, as before.
test("an exec gone by the second sample is not a hand-run writer; one that lasts is", () => {
  const exec = (id: string, script: string) => `E\tvirev-prod-crawler-api\t${JSON.stringify({ ID: id, Running: true, ProcessConfig: { entrypoint: "python", arguments: [script] } })}`;
  const lines = ["C\tvirev-prod-crawler-api\trunning|crawler-api|e1 e2 ||||virev-prod,", exec("e1", "/tmp/er_er_57ced8.py"), exec("e2", "/tmp/cw_extra_writer.py")];
  assert.deepEqual(handExecs(parseBox([...lines, "R\tvirev-prod-crawler-api\te2 "].join("\n")).execs).map(item => item.command), ["python /tmp/cw_extra_writer.py"]);
  assert.equal(handExecs(parseBox(lines.join("\n")).execs).length, 2);
});

// Guards the d3 run of 10-19 16:19Z: staging audit 14348 emptied the staging hand rows so the tier defaults applied, and read as an F1 repeat.
test("a change that only empties hand rows hands the keys back to their defaults, and an emptied pause row still counts", async () => {
  const reg = await registry();
  const reason = "p111 (crawler prod read-backs): empty the staging hand rows so the staging tier defaults (settings.py _STAGING_CONTROL_DEFAULTS) apply";
  const row = (id: number, key: string, cleared: boolean): AuditRow => ({ id, ts: AT, actor: "api-key", source: "ops-api", reason, key, cleared });
  const emptied = groupAudit("staging", [row(14348, "instagram_census.new_per_minute", true), row(14355, "tiktok_shop.product_per_minute", true)]);
  assert.equal(emptied.length, 1);
  assert.equal(classifyConfig(emptied[0]!, reg).kind, "exempt");
  const mixed = groupAudit("staging", [row(14348, "instagram_census.new_per_minute", true), row(14349, "tiktok_shop.product_per_minute", false)]);
  assert.equal(classifyConfig(mixed[0]!, reg).kind, "fault");
  const unpause = groupAudit("prod", [row(14400, "pause.instagram_census", true)]);
  assert.equal(classifyConfig(unpause[0]!, reg).kind, "fault");
  assert.match(auditSql(undefined, AT), /case when coalesce\(new_value, ''\) = '' then 1 else 0 end as cleared/);
});
