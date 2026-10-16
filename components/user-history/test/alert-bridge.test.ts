import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { ALERT_GOAL, AlertBridge, alertKey, ESCALATE_MS, OWNERS_PATH, ownerRoute, parseAlerts, parseOwners, readOwners, routerFor, stepNote, stepTitle, type FiringAlert, type OwnerMap } from "../src/alert-bridge.ts";
import { ALERT_ROUTES, routeAlert } from "../src/alert-routes.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { walkItems } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-14T01:30:00Z");
const MIN = 60_000;
const chat = (name: string) => ALERT_ROUTES.find(route => route.chat === name)!.session;
const CRAWLER = chat("Crawler VP");
const CI = chat("VP of CI");
const LAUNCH = chat("launch main bro");
const OPS = chat("ops guy");
const OWNERS_TEXT = readFileSync(new URL("./fixtures/alert-owners.json", import.meta.url), "utf8");
const OWNERS: OwnerMap = parseOwners(JSON.parse(OWNERS_TEXT));
const METAL = OWNERS.owners["metal box owner"]!;
const REPLAY = readFileSync(new URL("./fixtures/alert-replay-crawler-snapshot-down-20261014.json", import.meta.url), "utf8");

function raw(fingerprint: string, labels: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { fingerprint, startsAt: "2026-10-14T01:00:00.000Z", endsAt: "2026-10-14T01:34:00.000Z", updatedAt: "2026-10-14T01:30:00.000Z",
    generatorURL: `https://obs.virev.ai/alerting/grafana/${labels.__alert_rule_uid__ ?? fingerprint}/view`, annotations: { summary: `${labels.alertname} is firing.` },
    labels, receivers: [{ name: "ops-webhook" }], status: { state: "active", silencedBy: [], inhibitedBy: [] }, ...extra };
}
const ciAlert = raw("aaaa000000000001", { alertname: "CI runner queue over 30 min", __alert_rule_uid__: "ci-queue-wait", environment: "production" });

async function fixture(list: unknown[] = [], options: { owners?: OwnerMap; boardless?: readonly string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-"));
  const boards = new BoardStore(dir);
  let now = NOW;
  let alerts: unknown[] | null = list;
  const sent: { session: string; text: string }[] = [];
  const bridge = new AlertBridge({ file: join(dir, "alert-bridge.json"), boards, now: () => now, log: () => {},
    alerts: async () => alerts && parseAlerts(alerts),
    owners: async () => options.owners ?? null, hasBoard: async session => !options.boardless?.includes(session),
    deliver: async (session, text) => {
      sent.push({ session, text });
      return "sent";
    } });
  const steps = async (id: string): Promise<PlanItem[]> => {
    const found: PlanItem[] = [];
    walkItems((await boards.read(id))?.plan ?? [], item => { if (item.note?.startsWith("Grafana alert ")) found.push(item); });
    return found;
  };
  return { dir, boards, bridge, sent, steps, set: (next: unknown[] | null) => { alerts = next; }, at: (ms: number) => { now = ms; },
    state: async () => JSON.parse(await readFile(join(dir, "alert-bridge.json"), "utf8")) as { alerts: Record<string, { step: string; wokeAt: number; resolvedAt?: number }> } };
}

test("alert bridge: a new firing alert adds exactly one board step in the chat that owns it and sends no message", async () => {
  const f = await fixture([ciAlert]);
  await f.bridge.tick();
  const [step, ...more] = await f.steps(CI);
  assert.ok(step);
  assert.equal(more.length, 0);
  assert.equal(step.text, "Production CI runner queue over 30 min");
  assert.equal(step.status, "todo");
  assert.match(step.note!, /^Grafana alert aaaa000000000001, firing since 2026-10-14T01:00:00\.000Z\.$/m);
  assert.match(step.note!, /__alert_rule_uid__=ci-queue-wait, environment=production/);
  assert.match(step.note!, /https:\/\/obs\.virev\.ai\/alerting\/grafana\/ci-queue-wait\/view/);
  const goal = (await f.boards.read(CI))!.plan.find(item => item.children.some(child => child.id === step.id))!;
  assert.equal(goal.text, ALERT_GOAL);
  for (const other of [CRAWLER, LAUNCH, OPS]) assert.equal(await f.boards.read(other), null);
  assert.equal(f.sent.length, 0);
});

test("alert bridge: the same alert firing on later ticks adds no second step", async () => {
  const f = await fixture([ciAlert]);
  await f.bridge.tick();
  for (let tick = 1; tick <= 10; tick++) { f.at(NOW + tick * 30_000); await f.bridge.tick(); }
  assert.equal((await f.steps(CI)).length, 1);
  assert.equal(f.sent.length, 0);
});

test("alert bridge: a crash after the board write and before the state write adopts the step on the next tick instead of adding a second", async () => {
  const f = await fixture([ciAlert]);
  await f.bridge.tick();
  await rm(join(f.dir, "alert-bridge.json"));
  f.at(NOW + 30_000);
  await f.bridge.tick();
  const steps = await f.steps(CI);
  assert.equal(steps.length, 1);
  assert.equal((await f.state()).alerts[alertKey({ fingerprint: "aaaa000000000001", startsAt: "2026-10-14T01:00:00.000Z" })]!.step, steps[0]!.id);
});

test("alert bridge: replay of 10-15 12:41Z, the Crawler VP rewrites each note on every tick, and each firing stays one step", async () => {
  const at = Date.parse("2026-10-15T12:42:00Z");
  const firing = (fingerprint: string, startsAt: string, labels: Record<string, string>, summary: string) =>
    ({ ...raw(fingerprint, labels), startsAt, annotations: { summary } });
  const walk = firing("9b275075b2c23fd0", "2026-10-15T12:41:10.000Z",
    { alertname: "Production crawler health snapshot failing", __alert_rule_uid__: "crawler-prod-health-snapshot-down", job: "crawler-v3", snapshot: "engage_walk_sizes", world: "prod" },
    "The engage_walk_sizes health snapshot has failed for 10 minutes, so its gauges hold stale values.");
  const read = firing("4c1d2e3f40516273", "2026-10-15T12:41:10.000Z",
    { alertname: "Staging crawler health read over 2 s", __alert_rule_uid__: "crawler-staging-health-slow", job: "crawler-v3", world: "staging" }, "");
  const f = await fixture([walk, read]);
  for (let tick = 0; tick < 6; tick++) {
    f.at(at + tick * 70_000);
    await f.bridge.tick();
    const board = (await f.boards.read(CRAWLER))!;
    const ops: BoardOp[] = [];
    walkItems(board.plan, item => {
      if (item.note?.startsWith("Grafana alert ")) ops.push({ op: "plan_update", id: item.id, note: `Prod snapshot again (12:41Z). Land 37 fixes it.` });
    });
    if (ops.length) await f.boards.apply(CRAWLER, ops, "agent");
  }
  const ids: string[] = [];
  walkItems((await f.boards.read(CRAWLER))!.plan, item => { if (/health (snapshot failing|read over 2 s)/.test(item.text)) ids.push(item.id); });
  assert.equal(ids.length, 2);
  const state = await f.state();
  assert.deepEqual(Object.values(state.alerts).map(tracked => tracked.step).sort(), [...ids].sort());
});

test("alert bridge: a step the chat closed, or one it dropped, gets no escalation while its alert keeps firing", async () => {
  const f = await fixture([ciAlert, raw("aaaa000000000002", { alertname: "Runner disk under 10 GB", job: "runner" })]);
  await f.bridge.tick();
  const [first, second] = await f.steps(CI);
  await f.boards.apply(CI, [{ op: "plan_update", id: first!.id, status: "done" }, { op: "plan_update", id: second!.id, status: "dropped" }], "agent");
  f.at(NOW + 2 * ESCALATE_MS);
  await f.bridge.tick();
  assert.equal(f.sent.length, 0);
});

test("alert bridge: alerts that start in one tick each get one step in the chat that owns them", async () => {
  const crawler = [1, 2, 3].map(n => raw(`bbbb00000000000${n}`, { alertname: "Production stream entry waiting over 1 hour", job: "crawler-v3", stream: `crawl_profile:${n}` }));
  const f = await fixture([...crawler, ciAlert]);
  await f.bridge.tick();
  assert.equal((await f.steps(CRAWLER)).length, 3);
  assert.equal((await f.steps(CI)).length, 1);
  assert.equal(f.sent.length, 0);
});

test("alert bridge: an alert that leaves the firing list gets one resolved line on its step, and the step's status stays the chat's", async () => {
  const f = await fixture([ciAlert]);
  await f.bridge.tick();
  f.set([]);
  f.at(NOW + 7 * MIN);
  await f.bridge.tick();
  const [step] = await f.steps(CI);
  assert.equal(step!.status, "todo");
  assert.match(step!.note!, /\nThe alert resolved at 2026-10-14T01:37:00\.000Z, when the alert bridge saw it leave Grafana's firing list\.$/);
  assert.equal((await f.state()).alerts[alertKey(ciAlert)]!.resolvedAt, NOW + 7 * MIN);
  f.at(NOW + 8 * MIN);
  await f.bridge.tick();
  assert.equal((await f.steps(CI))[0]!.note, step!.note);
  assert.equal(f.sent.length, 0);
});

test("alert bridge: the same fingerprint firing again after it resolved is a new step", async () => {
  const f = await fixture([ciAlert]);
  await f.bridge.tick();
  f.set([]);
  f.at(NOW + 5 * MIN);
  await f.bridge.tick();
  f.set([{ ...ciAlert, startsAt: "2026-10-14T01:40:00.000Z" }]);
  f.at(NOW + 10 * MIN);
  await f.bridge.tick();
  assert.equal((await f.steps(CI)).length, 2);
  assert.deepEqual(Object.keys((await f.state()).alerts), [alertKey({ fingerprint: "aaaa000000000001", startsAt: "2026-10-14T01:40:00.000Z" })]);
});

test("alert bridge: replay of 10-15 06:20Z, one poll drops a firing whose step the chat closed with a reason, and the same firing seen on 4 polls stays one step", async () => {
  const at = Date.parse("2026-10-15T06:19:00Z");
  const snapshot = { ...raw("25d578850844031d", { alertname: "Production crawler health read over 2 s", __alert_rule_uid__: "crawler-prod-health-slow", job: "crawler-v3", world: "prod" }),
    startsAt: "2026-10-14T20:26:10.000Z" };
  const f = await fixture([snapshot]);
  const polls: unknown[][] = [[snapshot], [], [snapshot], [snapshot]];
  for (const [index, list] of polls.entries()) {
    f.set(list);
    f.at(at + index * 70_000);
    await f.bridge.tick();
    if (index === 0) {
      const [step] = await f.steps(CRAWLER);
      await f.boards.apply(CRAWLER, [{ op: "plan_update", id: step!.id, status: "done", note: "Closed: the prod health read is slow because of the 20:26Z deploy, land 37 fixes it." }], "agent");
    }
  }
  const ids: string[] = [];
  walkItems((await f.boards.read(CRAWLER))!.plan, item => { if (item.text.includes("health read over 2 s")) ids.push(item.id); });
  assert.equal(ids.length, 1);
  const tracked = (await f.state()).alerts[alertKey(snapshot)]!;
  assert.equal(tracked.step, ids[0]);
  assert.equal(tracked.resolvedAt, undefined);
});

test("alert bridge: silenced, inhibited and unprocessed alerts make no step, and no config file means no Grafana read", async () => {
  const f = await fixture([raw("cccc000000000001", { alertname: "Muted", job: "ci" }, { status: { state: "suppressed", silencedBy: ["s1"], inhibitedBy: [] } }),
    raw("cccc000000000002", { alertname: "Fresh", job: "ci" }, { status: { state: "unprocessed", silencedBy: [], inhibitedBy: [] } })]);
  await f.bridge.tick();
  assert.equal(await f.boards.read(CI), null);
  f.set(null);
  await f.bridge.tick();
  assert.equal(f.sent.length, 0);
});

test("alert bridge: the step goes under the chat's open alerts or ops goal, the bridge makes its own goal once, and a board at 6 open goals gets no seventh", async () => {
  const f = await fixture([raw("dddd000000000001", { alertname: "Dev box swap low", job: "devbox" })]);
  await f.boards.apply(OPS, [{ op: "plan_add", text: "This Mac stays healthy with alerts" }, { op: "plan_add", text: "Metal ops: backups and restores work" }], "agent");
  await f.bridge.tick();
  const board = (await f.boards.read(OPS))!;
  assert.deepEqual(board.plan.map(goal => goal.children.length), [0, 1]);

  const g = await fixture([ciAlert]);
  await g.boards.apply(CI, Array.from({ length: 6 }, (_, n) => ({ op: "plan_add" as const, text: `Goal ${n + 1}` })), "agent");
  await g.bridge.tick();
  const full = (await g.boards.read(CI))!;
  assert.equal(full.plan.length, 6);
  assert.equal(full.plan.at(-1)!.children.length, 1);

  const h = await fixture([ciAlert]);
  await h.bridge.tick();
  h.set([ciAlert, raw("aaaa000000000003", { alertname: "CI runner offline", job: "ci" })]);
  h.at(NOW + 30_000);
  await h.bridge.tick();
  const goals = (await h.boards.read(CI))!.plan.filter(goal => goal.text === ALERT_GOAL);
  assert.equal(goals.length, 1);
  assert.equal(goals[0]!.children.length, 2);
});

test("alert routes: words match whole tokens of the alertname, the rule uid and every label value, in table order", () => {
  const route = (alertname: string, labels: Record<string, string> = {}) => routeAlert([alertname, ...Object.values(labels)]).chat;
  assert.equal(route("Production crawler health snapshot failing"), "Crawler VP");
  assert.equal(route("Container memory >70% of limit", { name: "virev-prod-media-6", job: "crawler-v3" }), "Crawler VP");
  assert.equal(route("Census referrals gap", { snapshot: "instagram_census" }), "Crawler VP");
  assert.equal(route("A decision is overdue"), "ops guy");
  assert.equal(route("Queue wait", { __alert_rule_uid__: "ci-queue-wait" }), "VP of CI");
  assert.equal(route("launch-alert-bridge-test", { environment: "test", alert_group: "alert-bridge-test" }), "launch main bro");
  assert.equal(route("Watchlist sync behind"), "launch main bro");
  assert.equal(route("Portal 5xx", { service: "api_portal" }), "api portal vp");
  assert.equal(route("Signup errors", { app: "slack-green" }), "slack green guy");
  assert.equal(route("Dev box Docker VM swap free under 200 MB", { job: "devbox", box: "m2-air" }), "ops guy");
  assert.equal(route("Restore check failed", { box: "us-metal01", store: "opensearch" }), "ops guy");
});

test("alert bridge: a replay of crawler-prod-health-snapshot-down from 2026-10-14 01:29:10Z lands in Crawler VP under its crawler ops goal", async () => {
  const replay = JSON.parse(REPLAY) as unknown[];
  const alert: FiringAlert = parseAlerts(replay)[0]!;
  assert.equal(alert.labels.__alert_rule_uid__, "crawler-prod-health-snapshot-down");
  const f = await fixture(replay);
  f.at(Date.parse("2026-10-14T01:29:30Z"));
  await f.boards.apply(CRAWLER, [{ op: "plan_add", text: "Complete index of Instagram, Meta Ads and TikTok Shop (owner 10-09)" },
    { op: "plan_add", text: "Crawler ops: deploys keep the API up, health and keys stay safe, server tools and Grafana live in the code, and every documented route works" }], "agent");
  await f.bridge.tick();
  const board: ChatBoard = (await f.boards.read(CRAWLER))!;
  const [step] = await f.steps(CRAWLER);
  assert.equal(board.plan.find(goal => goal.text.startsWith("Crawler ops:"))!.children[0]!.id, step!.id);
  assert.equal(step!.text, "Production crawler health snapshot failing");
  assert.match(step!.note!, /^Grafana alert 60a82f58f945d61a, firing since 2026-10-14T01:29:10\.000Z\.\nAlert: Production crawler health snapshot failing\./);
  assert.match(step!.note!, /snapshot=instagram_census/);
  assert.match(step!.note!, /Grafana: https:\/\/obs\.virev\.ai\/alerting\/grafana\/crawler-prod-health-snapshot-down\/view$/);
  assert.equal(f.sent.length, 0);
  for (const other of ALERT_ROUTES.filter(route => route.session !== CRAWLER)) assert.equal(await f.boards.read(other.session), null);
});

const OWNER_CASES: [Record<string, string>, string][] = [
  [{ __alert_rule_uid__: "crawler-acquisitions-writer-lag" }, "Instagram Main"],
  [{ __alert_rule_uid__: "crawler-acquisitions-writer-lag-stg" }, "Instagram Main"],
  [{ __alert_rule_uid__: "crawler-prod-census-crawl-lag-seconds", box: "us-metal01" }, "Instagram Main"],
  [{ __alert_rule_uid__: "crawler-acquisitions-quarantine-stg" }, "crawler ops"],
  [{ __alert_rule_uid__: "metal-box-stop-silent", box: "us-metal01" }, "metal box owner"],
  [{ __alert_rule_uid__: "a-rule-added-later", box: "us-metal01" }, "metal box owner"],
  [{ __alert_rule_uid__: "mac-silent-mbp" }, "ops guy"],
  [{ __alert_rule_uid__: "hyperdx-error-logs", service: "crawler-v3" }, "crawler ops"],
  [{ __alert_rule_uid__: "hyperdx-error-logs", service: "search" }, "ops guy"],
  [{ __alert_rule_uid__: "hyperdx-error-logs" }, "ops guy"],
  [{ __alert_rule_uid__: "metal-backup-ch-redis-age", alertname: "ClickHouse or Redis backup older than 9h, or ClickHouse full older than 26h", box: "us-metal01", grafana_folder: "metal" }, "metal box owner"],
  [JSON.parse(REPLAY)[0].labels as Record<string, string>, "crawler ops"],
];

test("alert owners: owners.json routes match ops/alert-relay/owners.mjs ownerFor case for case, first route whose every label pattern matches wins", () => {
  for (const [labels, owner] of OWNER_CASES) assert.deepEqual(ownerRoute(labels, OWNERS), { owner, session: OWNERS.owners[owner] }, JSON.stringify(labels));
  assert.equal(ownerRoute({}, OWNERS), null);
  assert.throws(() => parseOwners({ ...JSON.parse(OWNERS_TEXT), fallback: "nobody" }), /names owner "nobody", which has no session/);
});

test("alert owners: an alert owners.json does not match, or any alert when the file is missing, goes by the keyword routes and then to ops guy", () => {
  const alert = (labels: Record<string, string>) => parseAlerts([raw("eeee000000000001", labels)])[0]!;
  const test = alert({ alertname: "launch-alert-bridge-test", __alert_rule_uid__: "launch-alert-bridge-test", environment: "test" });
  assert.equal(routerFor(OWNERS)(test), LAUNCH);
  assert.equal(routerFor(OWNERS)(alert({ alertname: "Something new", __alert_rule_uid__: "brand-new-rule" })), OPS);
  assert.equal(routerFor(OWNERS)(alert({ alertname: "Backup", __alert_rule_uid__: "metal-backup-x", box: "us-metal01" })), METAL);
  assert.equal(routerFor(null)(alert({ alertname: "Backup", __alert_rule_uid__: "metal-backup-x", box: "us-metal01" })), OPS);
});

test("alert owners: owners.json is read fresh from the checkout, and from a git ref while the checkout has no copy", async () => {
  const repo = await mkdtemp(join(tmpdir(), "alert-owners-"));
  const env = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const sh = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, stdio: "pipe" });
  sh("init", "-q");
  assert.equal(await readOwners(repo, ["HEAD"]), null);
  execFileSync("mkdir", ["-p", join(repo, "ops/alert-relay")]);
  await writeFile(join(repo, OWNERS_PATH), OWNERS_TEXT);
  sh("add", OWNERS_PATH);
  sh("commit", "-q", "-m", "owners");
  const ref = sh("rev-parse", "HEAD").toString().trim();
  await rm(join(repo, OWNERS_PATH));
  assert.deepEqual(await readOwners(repo, ["origin/main", ref]), OWNERS);
  await writeFile(join(repo, OWNERS_PATH), JSON.stringify({ ...JSON.parse(OWNERS_TEXT), fallback: "metal box owner" }));
  assert.equal((await readOwners(repo, [ref]))!.fallback, "metal box owner");
});

const YOUTUBE = readFileSync(new URL("./fixtures/alert-youtube-stream-wait-20261015.json", import.meta.url), "utf8");

test("alert bridge: the youtube stream-wait firing from 10-15 gets the rule title, and its summary, values and labels go in the note", async () => {
  const f = await fixture(JSON.parse(YOUTUBE) as unknown[]);
  await f.bridge.tick();
  const [step, ...more] = await f.steps(CRAWLER);
  assert.equal(more.length, 0);
  assert.equal(step!.text, "Production stream entry waiting over 1 hour");
  assert.match(step!.note!, /^Summary: crawl_profile:youtube group crawl_profile:youtube holds an entry 101632\.242 s old/m);
  assert.match(step!.note!, /^Values: A=101632\.242, C=1\.$/m);
  assert.match(step!.note!, /stream=crawl_profile:youtube/);
});

test("alert bridge: a title with no env gets the env label in front, and a title that names one stays as it is", () => {
  const title = (alertname: string, labels: Record<string, string>) => stepTitle(parseAlerts([raw("abcd000000000001", { alertname, ...labels })])[0]!);
  assert.equal(title("Instagram posts missing from content search", { world: "staging" }), "Staging Instagram posts missing from content search");
  assert.equal(title("Media backlog above baseline (production)", { env: "production" }), "Media backlog above baseline (production)");
  assert.equal(title("B2 influencer-dev inventory missing", { environment: "staging" }), "B2 influencer-dev inventory missing");
  assert.equal(title("Backup too old", { box: "us-metal01" }), "Backup too old");
  assert.equal(title("Queue wait in apps/crawler-v3/src/queue.ts", { env: "production" }), "A production Grafana alert is firing");
});

test("alert bridge: a step placed under the old summary title keeps its title when the same firing is seen again", async () => {
  const [alert] = JSON.parse(YOUTUBE) as unknown[];
  const parsed = parseAlerts([alert])[0]!;
  const f = await fixture([alert]);
  await f.boards.apply(CRAWLER, [{ op: "plan_add", text: "Firing prod alerts" }, { op: "plan_add", parent: "p1", text: "Prod YouTube job queue holds an entry stuck over a day" },
    { op: "plan_update", id: "p2", note: stepNote(parsed) }], "agent");
  await f.bridge.tick();
  const [step, ...more] = await f.steps(CRAWLER);
  assert.equal(more.length, 0);
  assert.equal(step!.text, "Prod YouTube job queue holds an entry stuck over a day");
});

test("alert bridge: an owner with no board, such as metal box owner, gets no step, message or escalation, and the firing is recorded until it resolves", async () => {
  const backup = raw("ffff000000000001", { alertname: "Backup too old", __alert_rule_uid__: "metal-backup-ch-redis-age", box: "us-metal01" });
  const f = await fixture([backup], { owners: OWNERS, boardless: [METAL] });
  await f.bridge.tick();
  assert.equal(await f.boards.read(METAL), null);
  for (const at of [ESCALATE_MS, 2 * ESCALATE_MS]) { f.at(NOW + at); await f.bridge.tick(); }
  f.set([]);
  await f.bridge.tick();
  assert.equal((await f.state()).alerts[alertKey(backup)]!.resolvedAt, NOW + 2 * ESCALATE_MS);
  assert.equal(f.sent.length, 0);
});

test("alert bridge: a step still open with no job 30 min after the bridge placed it sends ops guy one escalation, and never for a step a job owns or ops guy's own", async () => {
  const devbox = raw("dddd000000000009", { alertname: "Dev box swap low", job: "devbox" });
  const f = await fixture([ciAlert, devbox]);
  await f.bridge.tick();
  const [step] = await f.steps(CI);
  f.at(NOW + ESCALATE_MS - 30_000);
  await f.bridge.tick();
  assert.equal(f.sent.filter(({ text }) => text.startsWith("[alert-escalation]")).length, 0);
  f.at(NOW + ESCALATE_MS);
  await f.bridge.tick();
  const escalations = f.sent.filter(({ text }) => text.startsWith("[alert-escalation]"));
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0]!.session, OPS);
  assert.match(escalations[0]!.text, new RegExp(`^\\[alert-escalation\\] An alert step is still open with no job 30 min after the alert bridge put it on the owning chat's board: ${step!.id} "Production CI runner queue over 30 min" on VP of CI`));
  for (const at of [2, 3, 4]) { f.at(NOW + at * ESCALATE_MS); await f.bridge.tick(); }
  assert.equal(f.sent.filter(({ text }) => text.startsWith("[alert-escalation]")).length, 1);

  const g = await fixture([ciAlert]);
  await g.bridge.tick();
  await g.boards.apply(CI, [{ op: "plan_update", id: (await g.steps(CI))[0]!.id, job: "ci queue fix", status: "doing" }], "agent");
  g.at(NOW + 2 * ESCALATE_MS);
  await g.bridge.tick();
  assert.equal(g.sent.filter(({ text }) => text.startsWith("[alert-escalation]")).length, 0);
});

test("alert bridge: an alert labelled severity=test makes no step and no message", async () => {
  const f = await fixture([raw("abab000000000001", { alertname: "Relay test", job: "ci", severity: "test" })]);
  await f.bridge.tick();
  assert.equal(await f.boards.read(CI), null);
  assert.equal(f.sent.length, 0);
});
