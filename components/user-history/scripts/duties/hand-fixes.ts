import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoardStore } from "../../src/chat-board-store.ts";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, DAY, PG, REPO, SOURCE_DEADLINE_MS, grafanaClient, num, readGrafanaAuth, settle, sqlRows, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The Hand fix designs duty's precheck for launch main bro (`node --import tsx scripts/duties/hand-fixes.ts`). Code only, no model call, reads
 * only. The owner (10-14 01:30Z) asked that every fault fixed by hand become a design that fixes itself, and rule c63 says each hand fix starts
 * a design job the same turn. This check finds the hand fixes made since its last run and matches each to a fault in hand-fixes.faults.json:
 * - config_audit on prod and staging Postgres through Grafana (estate_pg_prod, estate_pg_stg, user grafana_ro); /ops/controls writes land there;
 * - ig_engage_account_events of kind status on prod and staging (grafana_ro reads kind, outcome, error_code, account_id and at, not the actor);
 * - launch main bro's board notes, and each fault's design refs: board steps in any chat, or a branch or commit in the auto-sns-agent checkout;
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
 * Targets in hand-fixes.duty.json, all <= 0, and their sources:
 * - undesigned_hand_fixes: the owner, 10-14, "자체적으로 고쳐질 수 있게 설계를 바꾸는게 니 역할이야"; a hand fix with no fault has no design.
 * - repeats_after_design: a hand fix for a fault whose design step is done means the design did not fix it.
 * - session_loops_writing: the box stop loop ran in an agent session and was down 08:50-13:52Z on 10-13 when that session hung (board s165).
 * - unsupervised_box_processes: the hand-started acquisition writer (docker exec) died in promote 9's restart and the writer fell 66 min
 *   behind (s160); the one-off copy container's idle prod session held promote 9 (s154).
 * - faults_without_job: rule c63, every hand fix starts a design job.
 * - source_errors: a source that failed is reported, never shown as green.
 * The schedule, daily, is the owner's "daily check" in the audit brief. timeoutMs 120000 is the runner's cap, PRECHECK_TIMEOUT_MS.
 */

export interface FaultMatch {
  config_key_prefixes?: string[]; config_reason_regex?: string; note_regex?: string;
  engage_event?: { kind: string; outcomes: string[] }; mac_process_regex?: string; box_exec_regex?: string; box_container_regex?: string;
}
/**
 * A fault's design work, one ref each: `pN` (a step on this chat's board), `<chat id>/pN` (a step on another chat's board), `branch:<name>` or
 * `commit:<sha>` (in the auto-sns-agent checkout, for work no board tracks).
 */
/** `done_at` is when the last design went live; a hand fix before it is not a repeat. */
export interface Fault { id: string; title: string; designs: string[]; owner: string; match: FaultMatch; done_at?: string }
export interface Registry {
  automatic_writers: { config_actors: string[] };
  exempt: { config_reason_regex: string; note_regex?: string; box_exec_regex?: string };
  faults: Fault[];
}

export type World = "prod" | "staging";
export interface AuditRow { id: number; ts: number; actor: string; key: string; reason: string; source: string }
export interface StatusEvent { accountId: number; at: number; outcome: string; errorCode: string }
export interface Note { id: string; at: number; text: string }
export interface BoardStep { id: string; status: string; job?: string }
/** What a design ref resolves to: a board step's status, or whether a branch or commit exists. */
export type RefState = { kind: "step"; status: string | null } | { kind: "git"; exists: boolean };
export interface BoxContainer { name: string; status: string; service: string }
export interface BoxExec { container: string; service: string; running: boolean; command: string }
export interface MacProcess { pid: number; command: string; script: string | null; writes: boolean }

/** One hand fix: config rows written together (same world, actor and reason in one minute) count once. */
export interface HandFix { source: string; at: number; what: string; text: string }
export type Verdict = { kind: "automatic" } | { kind: "exempt" } | { kind: "fault"; fault: Fault } | { kind: "undesigned" };
export type StepState = "none" | "live" | "done";

export type Source = "grafana auth" | "registry" | "board" | "box" | "mac" | `${World} config` | `${World} engage`;
const WORLDS: readonly World[] = ["prod", "staging"];
const READS: readonly Source[] = ["registry", "board", "prod config", "staging config", "prod engage", "staging engage"];
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  undesigned_hand_fixes: READS, repeats_after_design: READS,
  session_loops_writing: ["mac"], unsupervised_box_processes: ["box"], faults_without_job: ["registry", "board"],
};

/** Words that mark a board note as a report of a hand fix. */
export const HAND_FIX_WORDS = /\bby hand\b|hand-started|\bthaw(?:ed|s)?\b|\bre-?queued?\b|\breran\b|\brerun\b|\bre-?push(?:ed)?\b|\bcancell?ed \d+ runs\b|\bset (?:to )?(?:disabled|challenged)\b|operator refresh|\bCheck now\b/i;
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
    for (const pattern of [fault.match.config_reason_regex, fault.match.note_regex, fault.match.mac_process_regex, fault.match.box_exec_regex, fault.match.box_container_regex])
      if (pattern) new RegExp(pattern);
  }
  return registry;
}

/** Config rows grouped into hand fixes: rows of one world, actor and reason written in the same minute are one change. */
export function groupAudit(world: World, rows: readonly AuditRow[]): (HandFix & { actor: string; keys: string[] })[] {
  const groups = new Map<string, HandFix & { actor: string; keys: string[] }>();
  for (const row of rows) {
    const id = `${row.actor}\u0000${row.reason}\u0000${Math.floor(row.ts / 60_000)}`;
    const group = groups.get(id);
    if (group) { if (!group.keys.includes(row.key)) group.keys.push(row.key); continue; }
    groups.set(id, { source: `${world} config`, at: row.ts, what: `audit ${row.id}`, text: row.reason, actor: row.actor, keys: [row.key] });
  }
  return [...groups.values()].map(group => ({ ...group, what: `${group.what} ${group.keys.join(",")}`.slice(0, 160) }));
}

export function classifyConfig(fix: { actor: string; keys: readonly string[]; text: string }, registry: Registry): Verdict {
  if (registry.automatic_writers.config_actors.includes(fix.actor)) return { kind: "automatic" };
  if (new RegExp(registry.exempt.config_reason_regex).test(fix.text)) return { kind: "exempt" };
  const byReason = registry.faults.find(fault => fault.match.config_reason_regex && new RegExp(fault.match.config_reason_regex).test(fix.text));
  if (byReason) return { kind: "fault", fault: byReason };
  const byKey = registry.faults.find(fault => fault.match.config_key_prefixes?.some(prefix => fix.keys.some(key => key.startsWith(prefix))));
  return byKey ? { kind: "fault", fault: byKey } : { kind: "undesigned" };
}

/** A status event is a hand fix only when a fault names its kind and outcome; other status writes (imports, parks) are the product's own. */
export function classifyEvent(event: StatusEvent, registry: Registry): Verdict | null {
  const fault = registry.faults.find(item => item.match.engage_event?.kind === "status" && item.match.engage_event.outcomes.includes(event.outcome));
  return fault ? { kind: "fault", fault } : null;
}

/** A board note is a hand fix only when it says so in HAND_FIX_WORDS; then it matches a fault by its words, or it is undesigned. */
export function classifyNote(note: Note, registry: Registry): Verdict | null {
  if (!HAND_FIX_WORDS.test(note.text)) return null;
  if (registry.exempt.note_regex && new RegExp(registry.exempt.note_regex, "i").test(note.text)) return { kind: "exempt" };
  const fault = registry.faults.find(item => item.match.note_regex && new RegExp(item.match.note_regex, "i").test(note.text));
  return fault ? { kind: "fault", fault } : { kind: "undesigned" };
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

/** The ssh output: `C<TAB>name<TAB>status|service|execids` per container and `E<TAB>name<TAB><exec json>` per exec session. */
export function parseBox(text: string): { containers: BoxContainer[]; execs: BoxExec[] } {
  const containers: BoxContainer[] = [];
  const execs: BoxExec[] = [];
  const service = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [tag, name, rest] = line.split("\t");
    if (!name || rest === undefined) continue;
    if (tag === "C") {
      const [status = "", svc = ""] = rest.split("|");
      containers.push({ name, status, service: svc });
      service.set(name, svc);
    } else if (tag === "E") {
      const exec = JSON.parse(rest) as { Running?: boolean; ProcessConfig?: { entrypoint?: string; arguments?: string[] } };
      execs.push({ container: name, service: service.get(name) ?? "", running: exec.Running === true,
        command: [exec.ProcessConfig?.entrypoint ?? "", ...(exec.ProcessConfig?.arguments ?? [])].join(" ").trim() });
    }
  }
  return { containers, execs };
}

export const oneOffs = (containers: readonly BoxContainer[]): BoxContainer[] => containers.filter(container => !container.service);
/** A one-shot script piped in on stdin (`python -`, `bash -s`), the way session tools read or set controls; session_loops_writing counts those tools. */
const STDIN_SCRIPT = /\s(?:-|-s)$/;
/** `exempt` is the registry's exempt.box_exec_regex: an exec a declared unit on the box starts, so a restart does not lose it. */
export const handExecs = (execs: readonly BoxExec[], exempt?: string): BoxExec[] =>
  execs.filter(exec => exec.running && !DATA_SERVICES.has(exec.service) && !STDIN_SCRIPT.test(exec.command) && !(exempt && new RegExp(exempt).test(exec.command)));

/** The script a session process runs: the first argument ending in .py, .mjs, .js, .ts or .sh. */
export function scriptOf(command: string): string | null {
  return command.split(/\s+/).find(part => /\.(?:py|mjs|js|ts|sh)$/.test(part)) ?? null;
}
export const isSessionProcess = (command: string): boolean =>
  /\/llm-wiki\/content\/sessions\/|\/session-artifacts\//.test(command) && !/^(?:\/bin\/)?(?:ba|z)?sh -c\b|^tar\b/.test(command) && scriptOf(command) !== null;

export interface HandData {
  now: number;
  registry?: Registry; refs?: Map<string, RefState>; notes?: Note[];
  audit: Partial<Record<World, AuditRow[]>>; events: Partial<Record<World, StatusEvent[]>>;
  box?: { containers: BoxContainer[]; execs: BoxExec[] }; mac?: MacProcess[];
  errors: { source: Source; message: string }[];
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
    const fixes: { fix: HandFix; verdict: Verdict }[] = [];
    for (const world of WORLDS) {
      for (const fix of groupAudit(world, data.audit[world] ?? [])) fixes.push({ fix, verdict: classifyConfig(fix, registry) });
      for (const event of data.events[world] ?? []) {
        const verdict = classifyEvent(event, registry);
        if (verdict) fixes.push({ verdict, fix: { source: `${world} engage`, at: event.at, what: `account ${event.accountId}`, text: `set ${event.outcome}${event.errorCode ? ` (${event.errorCode})` : ""}` } });
      }
    }
    for (const note of data.notes ?? []) {
      const verdict = classifyNote(note, registry);
      if (verdict) fixes.push({ verdict, fix: { source: "board", at: note.at, what: note.id, text: note.text } });
    }
    const counted = fixes.filter(item => item.verdict.kind === "fault" || item.verdict.kind === "undesigned");
    const undesigned = counted.filter(item => item.verdict.kind === "undesigned");
    const repeats = counted.filter(item => item.verdict.kind === "fault" && stepState(item.verdict.fault, refs) === "done" &&
      !(item.verdict.fault.done_at && item.fix.at < Date.parse(item.verdict.fault.done_at)));
    metrics.undesigned_hand_fixes = undesigned.length;
    metrics.repeats_after_design = repeats.length;
    const byFault = new Map<string, number>();
    for (const item of counted) if (item.verdict.kind === "fault") byFault.set(item.verdict.fault.id, (byFault.get(item.verdict.fault.id) ?? 0) + 1);
    const skipped = fixes.length - counted.length;
    flagged.push({ at, kind: "hand_fixes", excerpt: `${counted.length} hand fixes since the last run` + (byFault.size ? `: ${[...byFault.entries()].map(([id, count]) => `${id} ${count}`).join(", ")}` : "") +
      `; ${undesigned.length} match no fault; ${skipped} automatic or exempt` });
    const line = (item: { fix: HandFix }) => `${item.fix.source} ${utc(item.fix.at)} ${item.fix.what}: ${item.fix.text}`.slice(0, 400);
    for (const item of undesigned) flagged.push({ at: item.fix.at, kind: "undesigned", excerpt: line(item) });
    for (const item of repeats) flagged.push({ at: item.fix.at, kind: "repeat", excerpt: `${item.verdict.kind === "fault" ? item.verdict.fault.id : ""} design step done, yet: ${line(item)}`.slice(0, 400),
      ...(item.verdict.kind === "fault" && item.verdict.fault.designs[0] ? { item: item.verdict.fault.designs[0] } : {}) });
    const jobless = registry.faults.filter(fault => stepState(fault, refs) === "none");
    metrics.faults_without_job = jobless.length;
    if (jobless.length) flagged.push({ at, kind: "faults_without_job", excerpt: `No live or done design work: ${jobless.map(fault => `${fault.id} ${fault.title} (${fault.owner})`).join("; ")}`.slice(0, 1000) });
  }
  if (data.mac) {
    const writers = data.mac.filter(process => process.writes);
    metrics.session_loops_writing = writers.length;
    if (writers.length) flagged.push({ at, kind: "session_loops", excerpt: `Agent session processes that write to prod or staging: ${writers.map(process => `pid ${process.pid} ${process.script ?? process.command.slice(0, 80)}`).join("; ")}`.slice(0, 1000) });
  }
  if (data.box) {
    const execs = handExecs(data.box.execs, registry?.exempt.box_exec_regex);
    const left = oneOffs(data.box.containers);
    metrics.unsupervised_box_processes = execs.length + left.length;
    for (const exec of execs) flagged.push({ at, kind: "box_exec", excerpt: `docker exec in ${exec.container}, gone at the next restart: ${exec.command}`.slice(0, 400) });
    if (left.length) flagged.push({ at, kind: "box_oneoff", excerpt: `Containers with no compose service: ${left.map(container => `${container.name} (${container.status})`).join(", ")}` });
  }
  metrics.source_errors = data.errors.length;
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics, flagged };
}

/** Where the last run stopped, per source; a source that failed keeps its old mark. The first run reads the last 24 h. */
export interface HandState { audit?: Partial<Record<World, number>>; events?: Partial<Record<World, number>>; notesAt?: number }

export function nextState(state: HandState, data: HandData): HandState {
  const next: HandState = { audit: { ...state.audit }, events: { ...state.events }, ...(state.notesAt !== undefined ? { notesAt: state.notesAt } : {}) };
  for (const world of WORLDS) {
    const rows = data.audit[world];
    if (rows) next.audit![world] = Math.max(state.audit?.[world] ?? 0, ...rows.map(row => row.id));
    const events = data.events[world];
    if (events) next.events![world] = Math.max(state.events?.[world] ?? data.now - DAY, ...events.map(event => event.at));
  }
  if (data.notes) next.notesAt = Math.max(state.notesAt ?? data.now - DAY, ...data.notes.map(note => note.at));
  return next;
}

export const auditSql = (lastId: number | undefined, now: number): string =>
  `select id, ts, actor, key, coalesce(reason, '') as reason, coalesce(source, '') as source from config_audit where ` +
  (lastId ? `id > ${Math.floor(lastId)}` : `ts >= to_timestamp(${Math.floor((now - DAY) / 1000)})`) + " order by id";
export const eventsSql = (after: number): string =>
  `select account_id, at, outcome, coalesce(error_code, '') as error_code from ig_engage_account_events where kind = 'status' and at > to_timestamp(${(after / 1000).toFixed(3)}) order by at`;

/** The one read-only box read: every container's status, compose service and running exec sessions, and each exec's command. */
export const BOX_SCRIPT = `set -u
for c in $(docker ps -a --format '{{.Names}}'); do
  info=$(docker inspect -f '{{.State.Status}}|{{index .Config.Labels "com.docker.compose.service"}}|{{range .ExecIDs}}{{.}} {{end}}' "$c")
  printf 'C\\t%s\\t%s\\n' "$c" "$info"
  for e in $(printf '%s' "$info" | cut -d'|' -f3); do
    printf 'E\\t%s\\t%s\\n' "$c" "$(curl -s --max-time 5 --unix-socket /var/run/docker.sock "http://localhost/exec/$e/json")"
  done
done
`;

function run(command: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${command} exit ${code}: ${(err || out).trim().slice(-300)}`)));
    child.stdin.end(input ?? "");
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

function flattenSteps(items: readonly { id: string; status?: string; job?: string; children?: unknown[] }[], into = new Map<string, BoardStep>()): Map<string, BoardStep> {
  for (const item of items) {
    into.set(item.id, { id: item.id, status: item.status ?? "todo", ...(item.job ? { job: item.job } : {}) });
    flattenSteps((item.children ?? []) as typeof items, into);
  }
  return into;
}
function flattenNotes(items: readonly { id: string; text?: string; at?: string; children?: unknown[] }[], into: Note[] = []): Note[] {
  for (const item of items) {
    if (item.at) into.push({ id: item.id, at: Date.parse(item.at), text: item.text ?? "" });
    flattenNotes((item.children ?? []) as typeof items, into);
  }
  return into;
}

export interface HandDeps {
  now: number; state: HandState; query: DsQuery | null; authError: string | null;
  registry: () => Promise<unknown>;
  /** One chat's board, or null when it has none. */
  board: (chat: string) => Promise<{ plan?: unknown[]; scratch?: unknown[] } | null>;
  /** Whether a `branch:<name>` or `commit:<sha>` ref exists in the auto-sns-agent checkout. */
  gitRef: (ref: string) => Promise<boolean>;
  box: () => Promise<string>; mac: () => Promise<MacProcess[]>;
}

export async function measure(deps: HandDeps): Promise<HandData> {
  const data: HandData = { now: deps.now, audit: {}, events: {}, errors: [] };
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
  const events = (world: World) => step(`${world} engage`, async () => (await sqlRows(query!, PG[world], eventsSql(deps.state.events?.[world] ?? deps.now - DAY))).map(row => ({
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
  if (registry) data.registry = registry;
  if (board) {
    const since = deps.state.notesAt ?? deps.now - DAY;
    data.notes = flattenNotes((board.scratch ?? []) as never[]).filter(note => note.at > since);
  }
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
  return data;
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
    box: () => run("ssh", ["-o", "BatchMode=yes", BOX, "bash -s"], signal, BOX_SCRIPT),
    mac: () => macProcesses(signal) });
  const result = report(data, dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(nextState(state, data)) + "\n");
  process.stdout.write(`hand-fixes: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
