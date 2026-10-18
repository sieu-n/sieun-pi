import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoardStore } from "../../src/chat-board-store.ts";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, DAY, PG, REPO, SOURCE_DEADLINE_MS, grafanaClient, num, readGrafanaAuth, settle, sqlRows, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The Hand fixes designed duty's precheck for launch main bro (`node --import tsx scripts/duties/hand-fixes.ts`). Code only, no model call, reads
 * only. The owner (10-14 01:30Z) asked that every fault fixed by hand become a design that fixes itself, and rule c63 says each hand fix starts
 * a design job the same turn. This check finds the hand fixes made since its last run and matches each to a fault in hand-fixes.faults.json:
 * - config_audit on prod and staging Postgres through Grafana (estate_pg_prod, estate_pg_stg, user grafana_ro); /ops/controls writes land there;
 * - ig_engage_account_events of kind status on prod and staging (grafana_ro reads kind, outcome, error_code, account_id and at, not the actor);
 * - each fault's design refs: board steps in any chat, or a branch or commit in the auto-sns-agent checkout;
 * - us-metal01 over one read-only ssh: containers with no compose service (one-off containers) and running docker exec sessions in app containers;
 * - this Mac's processes started from an agent session folder whose script writes to prod or staging config.
 * The fault list and the audit behind it: auto-sns-agent sessions/2026/10/14/1044-self-healing-audit (findings.html, duty-spec.html).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DUTY_FILE = join(HERE, "hand-fixes.duty.json");
export const REGISTRY_FILE = join(HERE, "hand-fixes.faults.json");
/** launch main bro, the chat whose board holds goal p96 and the design steps. */
export const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const BOX = "root@64.34.205.243";

/*
 * Targets in hand-fixes.duty.json, all <= 0, and their sources (rule c75: one headline and at most 3 supporting metrics):
 * - faults_without_job, the headline: rule c63, every hand fix starts a design job, and the owner, 10-14, "자체적으로 고쳐질 수 있게 설계를
 *   바꾸는게 니 역할이야"; a fault with no live or done design is one nobody is making fix itself. It also counts the faults this check files
 *   (filedAfter), one for each hand write kind no listed fault covers, from the run that first sees it until the registry lists a fault for it.
 * - undesigned_hand_fixes: a hand fix with no listed fault and no filed one has no design. A writer names its fault at the start of the reason
 *   (`F<n>: `, the ops write routes' `fault` field), which wins over the tag, the keys and the prose.
 * - repeats_after_design: a hand fix in the last 24 h for a fault whose design shipped means the design did not fix it. Shipped is every board
 *   step done, every `commit:` design in the release prod ran at the fix (afterDesign), and the fix not before done_at. Both 24 h metrics
 *   count the fixes since 24 h ago, as the duty labels say, while the read also reaches back to the last run's mark after a skipped day.
 * - hand_run_processes: session_loops_writing plus unsupervised_box_processes, both kept in the run detail. The box stop loop ran in an agent
 *   session and was down 08:50-13:52Z on 10-13 when that session hung (board s165); the hand-started acquisition writer (docker exec) died in
 *   promote 9's restart and the writer fell 66 min behind (s160); the one-off copy container's idle prod session held promote 9 (s154).
 * - source_errors is run detail. A source that failed turns every metric it feeds (NEEDS) into a miss and keeps its source_error flag.
 * The schedule, daily, is the owner's "daily check" in the audit brief. timeoutMs 120000 is the runner's cap, PRECHECK_TIMEOUT_MS.
 */

/**
 * How a config hand fix finds its fault, strongest evidence first. config_reason_tag is the writer's own label at the start of the reason
 * ("watch_proxy abort: ...", "TikTok Shop prod watch --act: ..."), so it wins over the keys. config_reason_regex is a cause named anywhere in
 * the prose and only decides when no key matches, because prose also names things that did not happen: audit 13533 on 10-16 raised census
 * rates with the words "no box stop since 00:40Z" and read as a guard repeat of F2 instead of a lane rate change of F1.
 */
export interface FaultMatch {
  config_key_prefixes?: string[]; config_reason_tag?: string; config_reason_regex?: string;
  engage_event?: { kind: string; outcomes: string[] }; mac_process_regex?: string; box_exec_regex?: string; box_container_regex?: string;
}
/**
 * A fault's design work, one ref each: `pN` (a step on this chat's board), `<chat id>/pN` (a step on another chat's board), `branch:<name>` or
 * `commit:<sha>` (in the auto-sns-agent checkout, for work no board tracks).
 */
/**
 * `done_at` is the floor of when the design went live; a hand fix before it is not a repeat. A fault with `commit:` refs also needs every one
 * of them in the prod release that ran at the fix (Deploy, releaseHolds), and with neither readable its repeats are not measured.
 */
export interface Fault { id: string; title: string; designs: string[]; owner: string; match: FaultMatch; done_at?: string }
/** config_sources names a supervised writer by config_audit.source, for an actor such as metal that also writes by hand. */
export interface Registry {
  automatic_writers: { config_actors: string[]; config_sources?: string[] };
  exempt: { config_reason_regex: string; box_exec_regex?: string };
  faults: Fault[];
}

export type World = "prod" | "staging";
export interface AuditRow { id: number; ts: number; actor: string; key: string; reason: string; source: string }
export interface StatusEvent { accountId: number; at: number; outcome: string; errorCode: string }
export interface BoardStep { id: string; status: string; job?: string }
/** What a design ref resolves to: a board step's status, or whether a branch or commit exists. */
export type RefState = { kind: "step"; status: string | null } | { kind: "git"; exists: boolean };
/** `oneoff` is set for a container scripts/copy-oneoff.sh started: its virev.expires_at in unix seconds (null when unreadable) and docker restart policy. */
export interface BoxContainer { name: string; status: string; service: string; oneoff?: { expiresAt: number | null; restart: string } }
export interface BoxExec { container: string; service: string; running: boolean; command: string }
export interface MacProcess { pid: number; command: string; script: string | null; writes: boolean }
/**
 * A process on the box that an ssh session left running on its own, with its script's text: parent pid 1 in a session-*.scope (nohup,
 * setsid), or the main process of a transient systemd-run unit, which no file in the repo declares and a reboot drops.
 */
export interface HostLoop { pid: number; command: string; text: string }

/**
 * A prod release going live: deploy.sh's `<time> prod deploy <sha12> ok` line in /srv/prod/releases/deploy.log on us-metal01. On 10-18 F18 read
 * as shipped from the start because its board step was done, while its design e0d09f5a42 reached prod only at 12:31:13Z (43490e7e9f, promote 12).
 */
export interface Deploy { at: number; release: string }
/** Whether a fault's `commit:` designs ran on prod at a time: `none` when it names no commit. */
export type OnProd = "none" | "live" | "not_live" | "unknown";

/** One hand fix: config rows written together (same world, actor and reason in one minute) count once. */
export interface HandFix { source: string; at: number; what: string; text: string }
export type Verdict = { kind: "automatic" } | { kind: "exempt" } | { kind: "fault"; fault: Fault } | { kind: "undesigned" };
export type StepState = "none" | "live" | "done";

export type Source = "grafana auth" | "registry" | "board" | "box" | "mac" | "prod deploys" | `${World} config` | `${World} engage`;
const WORLDS: readonly World[] = ["prod", "staging"];
const READS: readonly Source[] = ["registry", "prod config", "staging config", "prod engage", "staging engage"];
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  faults_without_job: ["registry", "board"], undesigned_hand_fixes: READS, repeats_after_design: [...READS, "board"], hand_run_processes: ["mac", "box"],
};

/** A script that changes prod or staging control state: /ops writes, the set_controls API, config table writes, Check now, proxy or engage account rows. */
export const WRITES = /\/ops\/(?:controls|config)\b|\bset_controls\(|\bUPDATE\s+config\b|\bINSERT\s+INTO\s+config(?:_audit)?\b|watchTargets:refresh|\bUPDATE\s+(?:proxy_endpoints|ig_engage_accounts)\b/i;
/** Data stores where other duties' read-only psql runs through docker exec; an exec there is not a hand-started worker. */
const DATA_SERVICES = new Set(["postgres", "clickhouse", "redis", "kafka", "opensearch", "langfuse-postgres", "langfuse-redis", "hdx-mongo"]);

export function parseRegistry(value: unknown): Registry {
  const registry = value as Registry;
  if (!registry?.automatic_writers || !Array.isArray(registry.automatic_writers.config_actors) || !registry.exempt?.config_reason_regex || !Array.isArray(registry.faults))
    throw new Error("hand-fixes.faults.json needs automatic_writers.config_actors, exempt.config_reason_regex and faults");
  for (const fault of registry.faults) {
    if (!/^F\d+$/.test(fault.id) || !fault.title || !fault.match || !Array.isArray(fault.designs)) throw new Error(`fault ${String(fault.id)}: id F<n>, title, designs and match`);
    if (fault.done_at !== undefined && Number.isNaN(Date.parse(fault.done_at))) throw new Error(`fault ${fault.id}: done_at ${fault.done_at} is not a time`);
    for (const ref of fault.designs) if (!/^(?:branch:\S+|commit:[0-9a-f]{7,40}|(?:[0-9a-f-]{36}\/)?p\d+)$/.test(ref)) throw new Error(`fault ${fault.id}: design ref ${ref} is not pN, <chat id>/pN, branch:<name> or commit:<sha>`);
    if (registry.exempt.box_exec_regex) new RegExp(registry.exempt.box_exec_regex);
    for (const pattern of [fault.match.config_reason_tag, fault.match.config_reason_regex, fault.match.mac_process_regex, fault.match.box_exec_regex, fault.match.box_container_regex])
      if (pattern) new RegExp(pattern);
  }
  return registry;
}

/** Config rows grouped into hand fixes: rows of one world, actor, source and reason written in the same minute are one change. */
export function groupAudit(world: World, rows: readonly AuditRow[]): (HandFix & { actor: string; writer: string; keys: string[] })[] {
  const groups = new Map<string, HandFix & { actor: string; writer: string; keys: string[] }>();
  for (const row of rows) {
    const id = `${row.actor}\u0000${row.source}\u0000${row.reason}\u0000${Math.floor(row.ts / 60_000)}`;
    const group = groups.get(id);
    if (group) { if (!group.keys.includes(row.key)) group.keys.push(row.key); continue; }
    groups.set(id, { source: `${world} config`, at: row.ts, what: `audit ${row.id}`, text: row.reason, actor: row.actor, writer: row.source, keys: [row.key] });
  }
  return [...groups.values()].map(group => ({ ...group, what: `${group.what} ${group.keys.join(",")}`.slice(0, 160) }));
}

/** The fault id a writer names at the start of the reason; crawler-v3's ops write routes store their `fault` field as `F<n>: <reason>`. */
const NAMED_FAULT = /^(F\d+): /;

export function classifyConfig(fix: { actor: string; writer?: string; keys: readonly string[]; text: string }, registry: Registry): Verdict {
  const automatic = registry.automatic_writers;
  if (automatic.config_actors.includes(fix.actor) || (fix.writer && automatic.config_sources?.includes(fix.writer))) return { kind: "automatic" };
  if (new RegExp(registry.exempt.config_reason_regex).test(fix.text)) return { kind: "exempt" };
  const named = NAMED_FAULT.exec(fix.text)?.[1];
  if (named) { const listed = registry.faults.find(item => item.id === named); return listed ? { kind: "fault", fault: listed } : { kind: "undesigned" }; }
  const fault = registry.faults.find(item => item.match.config_reason_tag && new RegExp(`^(?:${item.match.config_reason_tag})`).test(fix.text)) ??
    registry.faults.find(item => item.match.config_key_prefixes?.some(prefix => fix.keys.some(key => key.startsWith(prefix)))) ??
    registry.faults.find(item => item.match.config_reason_regex && new RegExp(item.match.config_reason_regex).test(fix.text));
  return fault ? { kind: "fault", fault } : { kind: "undesigned" };
}

/** A status event is a hand fix only when a fault names its kind and outcome; other status writes (imports, parks) are the product's own. */
export function classifyEvent(event: StatusEvent, registry: Registry): Verdict | null {
  const fault = registry.faults.find(item => item.match.engage_event?.kind === "status" && item.match.engage_event.outcomes.includes(event.outcome));
  return fault ? { kind: "fault", fault } : null;
}

/**
 * A fault's design state from its refs: done when it has board steps and every one is done; live when any step is open (todo, doing, blocked)
 * or any branch or commit exists; none otherwise (no refs, missing or dropped steps, no git ref).
 */
export function stepState(fault: Fault, refs: ReadonlyMap<string, RefState>): StepState {
  const states = fault.designs.map(ref => refs.get(ref));
  const steps = states.filter((state): state is { kind: "step"; status: string | null } => state?.kind === "step" && state.status !== null && state.status !== "dropped");
  if (steps.length && steps.length === states.filter(state => state?.kind === "step").length && steps.every(state => state.status === "done")) return "done";
  if (steps.some(state => state.status !== "done") || states.some(state => state?.kind === "git" && state.exists)) return "live";
  return "none";
}

/** Each step ref's status from the boards (`pN` is this chat's), or null when that board or step is missing. */
export function stepRefs(faults: readonly Fault[], boards: ReadonlyMap<string, ReadonlyMap<string, BoardStep>>): Map<string, RefState> {
  const refs = new Map<string, RefState>();
  for (const ref of faults.flatMap(fault => fault.designs)) {
    if (ref.startsWith("branch:") || ref.startsWith("commit:")) continue;
    const [chat, step] = ref.includes("/") ? ref.split("/") as [string, string] : [CHAT, ref];
    refs.set(ref, { kind: "step", status: boards.get(chat)?.get(step)?.status ?? null });
  }
  return refs;
}

/** The release prod ran at `at`: the last ok deploy at or before it, or undefined before the first logged one. */
export const releaseAt = (deploys: readonly Deploy[], at: number): Deploy | undefined =>
  deploys.reduce<Deploy | undefined>((last, deploy) => deploy.at <= at && (!last || deploy.at >= last.at) ? deploy : last, undefined);

/** Whether every `commit:` design of the fault was in the release prod ran at `at`; `held` maps a checked release to the commit refs it holds. */
export function designOnProd(fault: Fault, at: number, deploys: readonly Deploy[] | undefined, held: ReadonlyMap<string, ReadonlySet<string>>): OnProd {
  const commits = fault.designs.filter(ref => ref.startsWith("commit:"));
  if (!commits.length) return "none";
  const release = deploys && releaseAt(deploys, at);
  const holds = release && held.get(release.release);
  if (!holds) return "unknown";
  return commits.every(ref => holds.has(ref)) ? "live" : "not_live";
}

/** Whether a hand fix at `at` came after the fault's design shipped: its steps done, its commits on prod, and not before its done_at. */
export function afterDesign(fault: Fault, at: number, refs: ReadonlyMap<string, RefState>, deploys: readonly Deploy[] | undefined,
  held: ReadonlyMap<string, ReadonlySet<string>>): boolean | "unknown" {
  if (stepState(fault, refs) !== "done") return false;
  const floor = fault.done_at ? Date.parse(fault.done_at) : null;
  const prod = designOnProd(fault, at, deploys, held);
  if (prod === "unknown" && floor === null) return "unknown";
  return prod !== "not_live" && (floor === null || at >= floor);
}

/**
 * The ssh output: `C<TAB>name<TAB>status|service|execids|oneoff|expires_at|restart` per container, `E<TAB>name<TAB><exec json>` per exec
 * session, `H<TAB>pid<TAB><base64 json {command, text}>` per detached session process, and `D<TAB>time<TAB>sha12` per ok prod deploy.
 */
export function parseBox(text: string): { containers: BoxContainer[]; execs: BoxExec[]; hosts: HostLoop[]; deploys: Deploy[] } {
  const containers: BoxContainer[] = [];
  const execs: BoxExec[] = [];
  const hosts: HostLoop[] = [];
  const deploys: Deploy[] = [];
  const service = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [tag, name, rest] = line.split("\t");
    if (!name || rest === undefined) continue;
    if (tag === "C") {
      const [status = "", svc = "", , oneoff = "", expires = "", restart = ""] = rest.split("|");
      const expiresAt = /^\d+$/.test(expires) ? Number(expires) : null;
      containers.push({ name, status, service: svc, ...(oneoff === "true" ? { oneoff: { expiresAt, restart } } : {}) });
      service.set(name, svc);
    } else if (tag === "D") {
      const at = Date.parse(name);
      if (!Number.isNaN(at) && /^[0-9a-f]{12,40}$/.test(rest)) deploys.push({ at, release: rest });
    } else if (tag === "H") {
      const host = JSON.parse(Buffer.from(rest, "base64").toString("utf8")) as { command?: string; text?: string };
      hosts.push({ pid: Number(name), command: host.command ?? "", text: host.text ?? "" });
    } else if (tag === "E") {
      const exec = JSON.parse(rest) as { Running?: boolean; ProcessConfig?: { entrypoint?: string; arguments?: string[] } };
      execs.push({ container: name, service: service.get(name) ?? "", running: exec.Running === true,
        command: [exec.ProcessConfig?.entrypoint ?? "", ...(exec.ProcessConfig?.arguments ?? [])].join(" ").trim() });
    }
  }
  return { containers, execs, hosts, deploys };
}

/**
 * What a box script writes to prod or staging: WRITES, an SQL write, an /ops/ call, a detached docker exec (a hand-started worker), a
 * docker cp into a container or pg_repack. On 10-18 at 17:2xZ us-metal01 ran 7 such loops that ssh sessions left behind, which the
 * docker exec read never saw: the census, Meta Ads and TikTok Shop watchers that start the /tmp writers again after a restart, two Meta
 * Ads walk UPDATE loops and a census bio seed.
 */
export const HOST_WRITES = new RegExp(`${WRITES.source}|\\b(?:UPDATE\\s+\\w+(?:\\s+\\w+)?\\s+SET|INSERT\\s+INTO|DELETE\\s+FROM)\\b|/ops/|docker\\s+exec\\s+-d\\b|docker\\s+cp\\b|pg_repack|pkill\\b`, "i");
/** Detached session processes on the box whose script writes; read-only probes and monitors do not count. */
export const hostWriters = (hosts: readonly HostLoop[]): HostLoop[] => hosts.filter(host => HOST_WRITES.test(host.text));

/**
 * A one-off that runs itself: scripts/copy-oneoff.sh started it with a restart policy, so docker starts it again after a failure and an
 * exit 0 ends it, and deploy.sh starts it again after the deploy stopped it (start_oneoffs), until its expires_at. Before 10-18 every
 * deploy left the copy one-off stopped and its owner restarted it by hand. One past its expires_at, or with no restart policy, counts.
 */
export const keptOneOff = (container: BoxContainer, now: number): boolean =>
  !!container.oneoff && container.oneoff.expiresAt !== null && container.oneoff.expiresAt * 1000 > now && ["on-failure", "unless-stopped", "always"].includes(container.oneoff.restart);
/** Running containers with no compose service and no kept one-off; an exited one runs nothing, as posts-backfill-handrun after promote 12 on 10-18. */
export const oneOffs = (containers: readonly BoxContainer[], now: number): BoxContainer[] =>
  containers.filter(container => !container.service && container.status === "running" && !keptOneOff(container, now));
/** A one-shot script piped in on stdin (`python -`, `bash -s`), the way session tools read or set controls; session_loops_writing counts those tools. */
const STDIN_SCRIPT = /\s(?:-|-s)$/;
/** `exempt` is the registry's exempt.box_exec_regex: an exec a declared unit on the box starts, so a restart does not lose it. */
export const handExecs = (execs: readonly BoxExec[], exempt?: string): BoxExec[] =>
  execs.filter(exec => exec.running && !DATA_SERVICES.has(exec.service) && !STDIN_SCRIPT.test(exec.command) && !(exempt && new RegExp(exempt).test(exec.command)));

/** The script a session process runs: the first argument ending in .py, .mjs, .js, .ts or .sh. */
export function scriptOf(command: string): string | null {
  return command.split(/\s+/).find(part => /\.(?:py|mjs|js|ts|sh)$/.test(part)) ?? null;
}
/**
 * A CI gate or test script: in a gates, tests or ci folder, or named ci-*, test_* or *.test.*. It writes to a test database, not prod or
 * staging: on 10-18 the CI reds job's copy of apps/infra/metal/gates/ci-multirev-forward-tests.sh counted as 3 session writers.
 */
export const isCiOrTest = (script: string): boolean =>
  /\/(?:gates|tests?|__tests__|ci)\/[^/]+$|\/(?:ci|tests?)[-_][^/]*$|\.(?:test|spec)\.\w+$|_tests?\.\w+$/.test(script);
export const isSessionProcess = (command: string): boolean => {
  const script = scriptOf(command);
  return /\/llm-wiki\/content\/sessions\/|\/session-artifacts\//.test(command) && !/^(?:\/usr)?(?:\/bin\/)?(?:ba|z|da)?sh -c\b|^tar\b/.test(command) && script !== null && !isCiOrTest(script);
};

export interface HandData {
  now: number;
  registry?: Registry; refs?: Map<string, RefState>;
  audit: Partial<Record<World, AuditRow[]>>; events: Partial<Record<World, StatusEvent[]>>;
  box?: { containers: BoxContainer[]; execs: BoxExec[]; hosts?: HostLoop[] }; mac?: MacProcess[];
  errors: { source: Source; message: string }[];
  /** The faults earlier runs filed (HandState.filed). */
  filed?: Filed[];
  /** The ok prod deploys from the box read, and for each release checked, the `commit:` design refs it holds (releaseHolds). */
  deploys?: Deploy[]; held?: Map<string, Set<string>>;
}
/** A hand write kind with no listed fault, filed by this check: the config keys, when it first came, and its audit line. */
export interface Filed { keys: string[]; at: number; text: string; line: string }

type Fix = { fix: HandFix & { keys?: readonly string[] }; verdict: Verdict };

/** Every config change and fault-named engage status write this run read, each with its verdict. */
export function handFixes(data: HandData, registry: Registry): Fix[] {
  const fixes: Fix[] = [];
  for (const world of WORLDS) {
    for (const fix of groupAudit(world, data.audit[world] ?? [])) fixes.push({ fix, verdict: classifyConfig(fix, registry) });
    for (const event of data.events[world] ?? []) {
      const verdict = classifyEvent(event, registry);
      if (verdict) fixes.push({ verdict, fix: { source: `${world} engage`, at: event.at, what: `account ${event.accountId}`, text: `set ${event.outcome}${event.errorCode ? ` (${event.errorCode})` : ""}` } });
    }
  }
  return fixes;
}

const filedFor = (filed: readonly Filed[], fix: { keys?: readonly string[] }): Filed | undefined =>
  filed.find(entry => entry.keys.some(key => fix.keys?.includes(key)));

/**
 * The filed faults after this run: the earlier ones, then each hand write this run read that no listed fault covers and no filed one has
 * its key, less every entry a listed fault now covers by its keys or its reason. The registry only grew by hand from d3 jobs, and an
 * undesigned write counted once and was gone by the next run: audits 13970, 13971 and 13994 on 10-17 and 10-18 had no fault 3 runs in a row.
 */
export function filedAfter(previous: readonly Filed[], fixes: readonly Fix[], registry: Registry): Filed[] {
  const filed = [...previous];
  for (const { fix, verdict } of fixes)
    if (verdict.kind === "undesigned" && fix.keys?.length && !filedFor(filed, fix))
      filed.push({ keys: [...fix.keys], at: fix.at, text: fix.text.slice(0, 300), line: `${fix.source} ${utc(fix.at)} ${fix.what}`.slice(0, 200) });
  return filed.filter(entry => classifyConfig({ actor: "", keys: entry.keys, text: entry.text }, registry).kind !== "fault");
}

export function report(data: HandData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const at = data.now;
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = data.errors.map(error => ({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 400) }));
  const failed = new Set(data.errors.map(error => error.source));
  const unmeasured = new Set(Object.keys(NEEDS).filter(key => NEEDS[key]!.some(source => failed.has(source))));
  const registry = data.registry;
  const refs = data.refs ?? new Map<string, RefState>();
  if (registry) {
    const fixes = handFixes(data, registry);
    const recent = fixes.filter(item => item.fix.at >= at - DAY);
    const older = fixes.length - recent.length;
    const counted = recent.filter(item => item.verdict.kind === "fault" || item.verdict.kind === "undesigned");
    const undesigned = counted.filter(item => item.verdict.kind === "undesigned" && !filedFor(data.filed ?? [], item.fix));
    const held = data.held ?? new Map<string, Set<string>>();
    const after = (item: Fix) => item.verdict.kind === "fault" ? afterDesign(item.verdict.fault, item.fix.at, refs, data.deploys, held) : false;
    const repeats = counted.filter(item => after(item) === true);
    const unknown = [...new Set(counted.filter(item => after(item) === "unknown").map(item => item.verdict.kind === "fault" ? item.verdict.fault.id : ""))];
    if (unknown.length) {
      unmeasured.add("repeats_after_design");
      flagged.push({ at, kind: "source_error", excerpt: `prod deploys: ${unknown.join(", ")} name a commit: design and no done_at, and which commits prod ran at their hand fixes could not be read (the box's deploy.log or the auto-sns-agent checkout)`.slice(0, 400) });
    }
    const pending = registry.faults.filter(fault => stepState(fault, refs) === "done" && designOnProd(fault, at, data.deploys, held) === "not_live");
    if (pending.length) flagged.push({ at, kind: "design_not_on_prod", excerpt: `Design steps done, but a commit is in no prod release yet, so their hand fixes are not repeats: ${pending.map(fault => `${fault.id} ${fault.designs.filter(ref => ref.startsWith("commit:")).join(" ")}`).join("; ")}`.slice(0, 600) });
    metrics.undesigned_hand_fixes = undesigned.length;
    metrics.repeats_after_design = repeats.length;
    const byFault = new Map<string, number>();
    for (const item of counted) if (item.verdict.kind === "fault") byFault.set(item.verdict.fault.id, (byFault.get(item.verdict.fault.id) ?? 0) + 1);
    const skipped = recent.length - counted.length;
    flagged.push({ at, kind: "hand_fixes", excerpt: `${counted.length} hand fixes in 24 h` + (byFault.size ? `: ${[...byFault.entries()].map(([id, count]) => `${id} ${count}`).join(", ")}` : "") +
      `; ${undesigned.length} match no fault; ${skipped} automatic or exempt` + (older ? `; ${older} older changes since the last run are outside the 24 h metrics` : "") });
    const line = (item: { fix: HandFix }) => `${item.fix.source} ${utc(item.fix.at)} ${item.fix.what}: ${item.fix.text}`.slice(0, 400);
    for (const item of undesigned) flagged.push({ at: item.fix.at, kind: "undesigned", excerpt: line(item) });
    for (const item of repeats) flagged.push({ at: item.fix.at, kind: "repeat", excerpt: `${item.verdict.kind === "fault" ? item.verdict.fault.id : ""} design shipped, yet: ${line(item)}`.slice(0, 400),
      ...(item.verdict.kind === "fault" && item.verdict.fault.designs[0] ? { item: item.verdict.fault.designs[0] } : {}) });
    const jobless = registry.faults.filter(fault => stepState(fault, refs) === "none");
    const filed = filedAfter(data.filed ?? [], fixes, registry);
    metrics.faults_without_job = jobless.length + filed.length;
    if (jobless.length) flagged.push({ at, kind: "faults_without_job", excerpt: `No live or done design work: ${jobless.map(fault => `${fault.id} ${fault.title} (${fault.owner})`).join("; ")}`.slice(0, 1000) });
    for (const entry of filed) flagged.push({ at: entry.at, kind: "faults_without_job", excerpt: `Filed by this check, a hand write no listed fault covers, until hand-fixes.faults.json lists a fault for ${entry.keys.join(", ")}: ${entry.line}: ${entry.text}`.slice(0, 400) });
  }
  if (data.mac) {
    const writers = data.mac.filter(process => process.writes);
    metrics.session_loops_writing = writers.length;
    if (writers.length) flagged.push({ at, kind: "session_loops", excerpt: `Agent session processes that write to prod or staging: ${writers.map(process => `pid ${process.pid} ${process.script ?? process.command.slice(0, 80)}`).join("; ")}`.slice(0, 1000) });
  }
  if (data.box) {
    const execs = handExecs(data.box.execs, registry?.exempt.box_exec_regex);
    const left = oneOffs(data.box.containers, at);
    const kept = data.box.containers.filter(container => !container.service && container.status === "running" && keptOneOff(container, at));
    const loops = hostWriters(data.box.hosts ?? []);
    metrics.unsupervised_box_processes = execs.length + left.length + loops.length;
    for (const loop of loops) flagged.push({ at, kind: "box_host_loop", excerpt: `us-metal01 process started by hand over ssh, pid ${loop.pid}, gone at the next reboot: ${loop.command}`.slice(0, 400) });
    for (const exec of execs) flagged.push({ at, kind: "box_exec", excerpt: `docker exec in ${exec.container}, gone at the next restart: ${exec.command}`.slice(0, 400) });
    if (left.length) flagged.push({ at, kind: "box_oneoff", excerpt: `Containers with no compose service: ${left.map(container => `${container.name} (${container.status})`).join(", ")}` });
    if (kept.length) flagged.push({ at, kind: "box_oneoff_kept", excerpt: `One-offs that docker and deploy.sh start again, not counted: ${kept.map(container => `${container.name} (until ${utc(container.oneoff!.expiresAt! * 1000)})`).join(", ")}` });
  }
  if (data.mac && data.box) metrics.hand_run_processes = metrics.session_loops_writing! + metrics.unsupervised_box_processes!;
  const detail: Record<string, number> = { source_errors: data.errors.length };
  for (const key of ["session_loops_writing", "unsupervised_box_processes"]) if (key in metrics) detail[key] = metrics[key]!;
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics: { ...metrics, ...detail }, flagged };
}

/**
 * Where the last run stopped, per source; a source that failed keeps its old mark. Each run reads from that mark or from 24 h ago, whichever
 * is earlier, so a second run in a day still counts the day's fixes and a run after a skipped day still lists the older ones.
 */
export interface HandState { audit?: Partial<Record<World, number>>; events?: Partial<Record<World, number>>; filed?: Filed[] }

export function nextState(state: HandState, data: HandData): HandState {
  const next: HandState = { audit: { ...state.audit }, events: { ...state.events },
    filed: data.registry ? filedAfter(state.filed ?? [], handFixes(data, data.registry), data.registry) : state.filed ?? [] };
  for (const world of WORLDS) {
    const rows = data.audit[world];
    if (rows) next.audit![world] = Math.max(state.audit?.[world] ?? 0, ...rows.map(row => row.id));
    const events = data.events[world];
    if (events) next.events![world] = Math.max(state.events?.[world] ?? data.now - DAY, ...events.map(event => event.at));
  }
  return next;
}

export const auditSql = (lastId: number | undefined, now: number): string =>
  `select id, ts, actor, key, coalesce(reason, '') as reason, coalesce(source, '') as source from config_audit where ` +
  (lastId ? `(id > ${Math.floor(lastId)} or ` : "(") + `ts >= to_timestamp(${Math.floor((now - DAY) / 1000)})) order by id`;
export const eventsSql = (after: number): string =>
  `select account_id, at, outcome, coalesce(error_code, '') as error_code from ig_engage_account_events where kind = 'status' and at > to_timestamp(${(after / 1000).toFixed(3)}) order by at`;

/** The one read-only box read: every container's status, compose service and running exec sessions, each exec's command, and the ok prod deploys. */
export const BOX_SCRIPT = `set -u
awk '$2 == "prod" && $3 == "deploy" && $5 == "ok:" { printf "D\\t%s\\t%s\\n", $1, $4 }' /srv/prod/releases/deploy.log
for c in $(docker ps -a --format '{{.Names}}'); do
  info=$(docker inspect -f '{{.State.Status}}|{{index .Config.Labels "com.docker.compose.service"}}|{{range .ExecIDs}}{{.}} {{end}}|{{index .Config.Labels "virev.oneoff"}}|{{index .Config.Labels "virev.expires_at"}}|{{.HostConfig.RestartPolicy.Name}}' "$c")
  printf 'C\\t%s\\t%s\\n' "$c" "$info"
  for e in $(printf '%s' "$info" | cut -d'|' -f3); do
    printf 'E\\t%s\\t%s\\n' "$c" "$(curl -s --max-time 5 --unix-socket /var/run/docker.sock "http://localhost/exec/$e/json")"
  done
done
python3 - <<'PY'
import base64, json, os, re
for pid in filter(str.isdigit, os.listdir('/proc')):
    try:
        cg = open(f'/proc/{pid}/cgroup').read()
        ppid = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()[1]
        argv = [a for a in open(f'/proc/{pid}/cmdline', 'rb').read().decode(errors='replace').split('\\0') if a]
        cwd = os.readlink(f'/proc/{pid}/cwd')
    except OSError:
        continue
    unit = re.search(r'/system\\.slice/([^/\\s]+\\.service)$', cg.strip())
    transient = bool(unit) and os.path.exists('/run/systemd/transient/' + unit.group(1))
    if ppid != '1' or not (re.search(r'session-\\d+\\.scope', cg) or transient) or not argv or argv[0].startswith('sshd'):
        continue
    text = ' '.join(argv)
    for a in argv[1:]:
        if re.search(r'\\.(?:sh|py)$', a):
            try: text += '\\n' + open(os.path.join(cwd, a), errors='replace').read(65536)
            except OSError: pass
            break
    print('H\\t%s\\t%s' % (pid, base64.b64encode(json.dumps({'command': ' '.join(argv)[:300], 'text': text}).encode()).decode()))
PY
`;

function run(command: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A command with no input gets no stdin pipe: on 10-18 a ps, lsof or git that exited before the empty write crashed the run with EPIPE.
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout!.on("data", chunk => { out += chunk; });
    child.stderr!.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${command} exit ${code}: ${(err || out).trim().slice(-300)}`)));
    if (child.stdin) { child.stdin.on("error", reject); child.stdin.end(input); }
  });
}

/** The text a session script holds with its same-folder imports and the same-folder scripts it names, so a write in a helper counts. */
async function scriptText(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  const dir = dirname(path);
  const names = [...text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map(match => (match[1] ?? match[2])!.split(".")[0]!)
    .concat([...text.matchAll(/from\s+["']\.\/([\w.-]+)["']/g)].map(match => match[1]!))
    .concat([...text.matchAll(/([\w-]+\.(?:py|sh|mjs))\b/g)].map(match => match[1]!));
  const extra = await Promise.all([...new Set(names)].map(name => readFile(join(dir, /\.\w+$/.test(name) ? name : `${name}.py`), "utf8").catch(() => "")));
  return [text, ...extra].join("\n");
}

/** This Mac's processes started from an agent session folder, and whether each script writes to prod or staging. */
export async function macProcesses(signal: AbortSignal): Promise<MacProcess[]> {
  const lines = (await run("ps", ["-axww", "-o", "pid=,command="], signal)).split("\n");
  const found: MacProcess[] = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !isSessionProcess(match[2]!)) continue;
    const pid = Number(match[1]);
    const command = match[2]!;
    let script = scriptOf(command);
    if (script && !isAbsolute(script)) {
      const cwd = (await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], signal).catch(() => "")).split("\n").find(item => item.startsWith("n"))?.slice(1);
      script = cwd ? join(cwd, script) : null;
    }
    const writes = script ? WRITES.test(await scriptText(script).catch(() => "")) : false;
    found.push({ pid, command, script, writes });
  }
  return found;
}

/**
 * Whether a prod release holds a commit, in the auto-sns-agent checkout. A land squashes its pinned sieun/dev tip into one staging commit with
 * the same tree (land 38, 43490e7e9f, is d2119eae32's tree), so the commit counts when it is an ancestor of the release or of a commit with the
 * release's tree, or when one of those holds a commit whose `Replayed-From` trailer names it (land-object.mjs replays an object onto the tip).
 */
export function gitReleaseHolds(git: (args: string[]) => Promise<string>): (release: string, commit: string) => Promise<boolean> {
  let trees: Promise<Map<string, string[]>> | undefined;
  const byTree = () => trees ??= git(["log", "--all", "--format=%H %T"]).then(out => {
    const map = new Map<string, string[]>();
    for (const [sha, tree] of out.split("\n").map(line => line.split(" "))) if (sha && tree) map.set(tree, [...map.get(tree) ?? [], sha]);
    return map;
  });
  return async (release, commit) => {
    const sha = (await git(["rev-parse", "--verify", `${commit}^{commit}`])).trim();
    const tip = (await git(["rev-parse", "--verify", `${release}^{commit}`])).trim();
    const tree = (await git(["rev-parse", "--verify", `${tip}^{tree}`])).trim();
    for (const head of new Set([tip, ...(await byTree()).get(tree) ?? []])) {
      if (await git(["merge-base", "--is-ancestor", sha, head]).then(() => true, () => false)) return true;
      if ((await git(["log", "-1", "--format=%H", "--fixed-strings", `--grep=Replayed-From: ${sha}`, head])).trim()) return true;
    }
    return false;
  };
}

function flattenSteps(items: readonly { id: string; status?: string; job?: string; children?: unknown[] }[], into = new Map<string, BoardStep>()): Map<string, BoardStep> {
  for (const item of items) {
    into.set(item.id, { id: item.id, status: item.status ?? "todo", ...(item.job ? { job: item.job } : {}) });
    flattenSteps((item.children ?? []) as typeof items, into);
  }
  return into;
}

export interface HandDeps {
  now: number; state: HandState; query: DsQuery | null; authError: string | null;
  registry: () => Promise<unknown>;
  /** One chat's board, or null when it has none. */
  board: (chat: string) => Promise<{ plan?: unknown[] } | null>;
  /** Whether a `branch:<name>` or `commit:<sha>` ref exists in the auto-sns-agent checkout. */
  gitRef: (ref: string) => Promise<boolean>;
  /** Whether a prod release (a sha from deploy.log) holds a commit; throws when either cannot be read. */
  releaseHolds: (release: string, commit: string) => Promise<boolean>;
  box: () => Promise<string>; mac: () => Promise<MacProcess[]>;
}

export async function measure(deps: HandDeps): Promise<HandData> {
  const data: HandData = { now: deps.now, audit: {}, events: {}, errors: [], filed: deps.state.filed ?? [] };
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const query = deps.query;
  if (!query) {
    data.errors.push({ source: "grafana auth", message: deps.authError ?? "no Grafana login" });
    for (const world of WORLDS) for (const kind of ["config", "engage"] as const) data.errors.push({ source: `${world} ${kind}`, message: "not read: no Grafana login" });
  }
  const audit = (world: World) => step(`${world} config`, async () => (await sqlRows(query!, PG[world], auditSql(deps.state.audit?.[world], deps.now))).map(row => ({
    id: num(row.id) ?? 0, ts: num(row.ts) ?? 0, actor: String(row.actor ?? ""), key: String(row.key ?? ""), reason: String(row.reason ?? ""), source: String(row.source ?? "") })));
  const events = (world: World) => step(`${world} engage`, async () => (await sqlRows(query!, PG[world], eventsSql(Math.min(deps.state.events?.[world] ?? deps.now, deps.now - DAY)))).map(row => ({
    accountId: num(row.account_id) ?? 0, at: num(row.at) ?? 0, outcome: String(row.outcome ?? ""), errorCode: String(row.error_code ?? "") })));
  const [registry, board, box, mac, prodAudit, stagingAudit, prodEvents, stagingEvents] = await Promise.all([
    step("registry", async () => parseRegistry(await deps.registry())),
    step("board", async () => { const board = await deps.board(CHAT); if (!board) throw new Error(`no board for chat ${CHAT}`); return board; }),
    step("box", async () => parseBox(await deps.box())),
    step("mac", deps.mac),
    query ? audit("prod") : undefined, query ? audit("staging") : undefined,
    query ? events("prod") : undefined, query ? events("staging") : undefined,
  ]);
  if (box && !box.containers.length) data.errors.push({ source: "box", message: "the ssh read listed no container" });
  else if (box) data.box = box;
  if (box?.deploys.length) data.deploys = box.deploys;
  if (registry) data.registry = registry;
  if (registry && board) {
    const refs = await step("board", async () => {
      const chats = new Set(registry.faults.flatMap(fault => fault.designs).filter(ref => /^[0-9a-f-]{36}\//.test(ref)).map(ref => ref.split("/")[0]!));
      const boards = new Map<string, Map<string, BoardStep>>([[CHAT, flattenSteps((board.plan ?? []) as never[])]]);
      for (const chat of chats) { const other = await deps.board(chat); if (other) boards.set(chat, flattenSteps((other.plan ?? []) as never[])); }
      const refs = stepRefs(registry.faults, boards);
      for (const ref of new Set(registry.faults.flatMap(fault => fault.designs).filter(item => /^(?:branch|commit):/.test(item))))
        refs.set(ref, { kind: "git", exists: await deps.gitRef(ref) });
      return refs;
    });
    if (refs) data.refs = refs;
  }
  if (mac) data.mac = mac;
  if (prodAudit) data.audit.prod = prodAudit;
  if (stagingAudit) data.audit.staging = stagingAudit;
  if (prodEvents) data.events.prod = prodEvents;
  if (stagingEvents) data.events.staging = stagingEvents;
  if (registry && data.deploys) data.held = await heldBy(deps, data, registry);
  return data;
}

/** The `commit:` refs each needed release holds: the release prod ran at each listed fault's hand fix, and the one it runs now. */
async function heldBy(deps: HandDeps, data: HandData, registry: Registry): Promise<Map<string, Set<string>>> {
  const needed = new Map<string, Set<string>>();
  const want = (fault: Fault, at: number) => {
    const release = releaseAt(data.deploys!, at)?.release;
    const commits = fault.designs.filter(ref => ref.startsWith("commit:"));
    if (!release || !commits.length) return;
    needed.set(release, new Set([...needed.get(release) ?? [], ...commits]));
  };
  for (const { fix, verdict } of handFixes(data, registry)) if (verdict.kind === "fault") want(verdict.fault, fix.at);
  for (const fault of registry.faults) want(fault, data.now);
  const held = new Map<string, Set<string>>();
  for (const [release, commits] of needed) {
    try {
      const holds = new Set<string>();
      for (const ref of commits) if (await deps.releaseHolds(release, ref.slice("commit:".length))) holds.add(ref);
      held.set(release, holds);
    } catch (error) {
      data.errors.push({ source: "prod deploys", message: `release ${release}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    }
  }
  return held;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("hand-fixes: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const stateFile = process.env.STATE_FILE;
  const state = stateFile ? JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}")) as HandState : {};
  const now = Date.now();
  const signal = AbortSignal.timeout(SOURCE_DEADLINE_MS);
  let query: DsQuery | null = null;
  let authError: string | null = null;
  try { query = grafanaClient(fetch, await readGrafanaAuth(), now, signal); } catch (error) { authError = error instanceof Error ? error.message : String(error); }
  const data = await measure({ now, state, query, authError,
    registry: async () => JSON.parse(await readFile(REGISTRY_FILE, "utf8")),
    board: chat => new BoardStore(join(homedir(), ".prime/agent/browser-chat")).read(chat) as never,
    gitRef: ref => run("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", ref.startsWith("branch:") ? `refs/heads/${ref.slice(7)}` : `${ref.slice(7)}^{commit}`], signal).then(() => true, () => false),
    releaseHolds: gitReleaseHolds(args => run("git", ["-C", REPO, ...args], signal)),
    box: () => run("ssh", ["-o", "BatchMode=yes", BOX, "bash -s"], signal, BOX_SCRIPT),
    mac: () => macProcesses(signal) });
  const result = report(data, dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(nextState(state, data)) + "\n");
  process.stdout.write(`hand-fixes: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
