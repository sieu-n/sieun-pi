/**
 * Splits today's agents into a comm thread and a work thread (apps/chat/docs/agent-model.md, phase 4; /home/sieun/work/phase4/spec.md).
 * A dry run by default: it reads the data dir's `agents.json`, `rooms.json` and room logs, and pi-host through a host that refuses every
 * write, and prints per agent what `Agents.splitPlan` says the split changes, what stays, and what runs in the work thread now, so the
 * coordinator can pick a quiet moment. `--apply` asks the live server's `POST /api/agents/:id/split` for the same agents, so the running
 * server stays the only writer of `agents.json`; this script never writes a file or a thread. With no `--agent` it takes every agent that is
 * not archived.
 *
 *   node --import tsx scripts/split-agents.ts [--data-dir <dir>] [--socket <pi-host socket>] [--agents-dir <dir>] [--agent ag_x ...]
 *   node --import tsx scripts/split-agents.ts --apply --url http://127.0.0.1:5184 [--data-dir <dir>] [--agent ag_x ...]
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { TurnPlace } from "../web/src/lib/api/types.ts";
import type { PlanItem } from "../web/src/lib/api/shared/types.ts";
import { parseBoard } from "../web/src/lib/api/shared/chat-board.ts";
import { agentFolderDir, type AgentRef } from "../server/agent-folder.ts";
import { AgentStore, type AgentRecord, type FeedCursor } from "../server/agent-store.ts";
import { Agents, type SplitPlan } from "../server/agents.ts";
import { BOARD_DOC, type DutyFile } from "../server/boards.ts";
import { readConfig } from "../server/config.ts";
import { PiHost } from "../server/host/pi-host.ts";
import type { Host, TreeNode } from "../server/host/types.ts";
import { readJson, type StateFile, type Store } from "../server/store.ts";

// pi-host's role fields, which it applies when the ref lands. It is imported by a path tsc does not follow, because pi-host's vendored Prime
// code does not pass this package's noUncheckedIndexedAccess.
const PROFILE = "../../../packages/pi-host/src/durable/agent-profile.ts";
type RoleFields = { tools?: { remove?: string[] }; modelTools?: { add?: string[] }; instructions?: string };
const { roleFields } = (await import(PROFILE)) as { roleFields: (ref: AgentRef) => RoleFields };

const READS = new Set<string | symbol>(["name", "threads", "ticket", "tree", "entries", "docGet", "ping", "close"]);

/** The host with only its read calls; any other call rejects, so a dry run cannot write a thread whatever the plan code does. */
export function readOnlyHost(host: Host): Host {
  return new Proxy(host, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!READS.has(key)) return () => Promise.reject(new Error(`split-agents dry run refuses ${String(key)}: it writes`));
      return value.bind(target);
    },
  });
}

export interface SplitReport {
  record: AgentRecord;
  plan: SplitPlan;
  /** The work thread now: its run status, its open child conversations and its root conversation's place in pi-pool's turn queue. */
  live: { status: string; children: Pick<TreeNode, "id" | "name" | "status">[]; place: TurnPlace | null; newestEntry: number };
  /** The feed reads the work thread from `before.entry` to its newest entry once, then the comm thread from entry 0. */
  feed: { before: FeedCursor | null; drain: { from: number; to: number }; after: { thread: string; entry: 0 } };
  /** Owner posts still `sending`; after the split their next try goes to the comm thread. */
  sending: { id: string; at: number; attempts: number; text: string }[];
  stays: {
    jobs: { thread: string; name: string; status: string }[];
    board: { steps: number; open: number; todos: number } | null;
    duties: { dir: string; names: string[]; checkIn: DutyFile["checkIn"] | null };
    folder: { dir: string; exists: boolean };
  };
}

function countSteps(plan: readonly PlanItem[]): { steps: number; open: number } {
  let steps = 0;
  let open = 0;
  const walk = (items: readonly PlanItem[]) => {
    for (const item of items) {
      steps++;
      if (item.status !== "done" && item.status !== "dropped") open++;
      walk(item.children);
    }
  };
  walk(plan);
  return { steps, open };
}

/** `Boards.dir`: an agent's duties live in `agents/<id>/`, or in its old `boards/<work thread>/` until the migration copied them. */
function dutiesDir(dataDir: string, record: AgentRecord): string {
  const fresh = join(dataDir, "agents", record.id);
  const old = join(dataDir, "boards", record.workThread);
  return existsSync(fresh) || !existsSync(old) ? fresh : old;
}

/** The dry run of one agent; reads only. */
export async function splitReport(agents: Agents, record: AgentRecord): Promise<SplitReport> {
  const { host, store } = agents;
  const work = record.workThread;
  const plan = await agents.splitPlan(record);
  const [rows, tree, place, newest, boardDoc] = await Promise.all([
    host.threads(),
    host.tree(work),
    host.ticket(work, 1).then(t => t?.place ?? null, () => null),
    host.entries(work, { conversation: 1, limit: 1 }),
    host.docGet(work, BOARD_DOC),
  ]);
  const rowOf = new Map(rows.map(r => [r.id, r]));
  const newestEntry = newest.entries[0]?.id ?? 0;
  const cursor = store.rooms.feed[record.id] ?? null;
  let board: SplitReport["stays"]["board"] = null;
  try {
    const parsed = boardDoc ? parseBoard(boardDoc) : null;
    if (parsed) board = { ...countSteps(parsed.plan), todos: parsed.todos.filter(t => !t.done).length };
  } catch {
    board = null;
  }
  const dir = dutiesDir(store.dir, record);
  const duties = readJson<DutyFile>(join(dir, "duties.json"), { duties: [], runs: {} });
  return {
    record, plan,
    live: {
      status: rowOf.get(work)?.status ?? "unlisted",
      children: tree.filter(n => n.parent !== null && n.status === "running").map(n => ({ id: n.id, name: n.name, status: n.status })),
      place, newestEntry,
    },
    feed: { before: cursor, drain: { from: cursor?.entry ?? newestEntry, to: newestEntry }, after: { thread: plan.comm.thread ?? "<new>", entry: 0 } },
    sending: store.postsOf(record.room).filter(p => p.delivery?.state === "sending")
      .map(p => ({ id: p.id, at: p.at, attempts: p.delivery!.attempts, text: p.text.replace(/\s+/g, " ").slice(0, 100) })),
    stays: {
      jobs: agents.jobThreads(record).map(thread => ({ thread, name: rowOf.get(thread)?.name ?? "(not listed)", status: rowOf.get(thread)?.status ?? "unlisted" })),
      board,
      duties: { dir, names: duties.duties.map(d => `${d.id} ${d.name}`), checkIn: duties.checkIn ?? null },
      folder: { dir: agentFolderDir(agents.config.agentsDir, record), exists: existsSync(agentFolderDir(agents.config.agentsDir, record)) },
    },
  };
}

const json = (value: unknown) => JSON.stringify(value);
const when = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const placeText = (place: TurnPlace | null) =>
  !place || place.state === "none" ? "no run in the turn queue" : place.state === "queued" ? `queued ${place.position} of ${place.total}` : place.state === "working" ? `working (${place.kind} slot)` : "marked as the owner's turn";

/** The tools and instructions pi-host gives the root conversation for the ref's role (`roleFields`), as report lines. */
function role(label: string, ref: AgentRef): string[] {
  const fields = roleFields(ref);
  return [
    `  - The ${label} loses the tools ${fields.tools?.remove?.join(", ") || "none"}${fields.modelTools?.add?.length ? ` and is offered ${fields.modelTools.add.join(", ")}` : ""}, and gets these instructions:`,
    ...(fields.instructions ?? "").split("\n").map(line => `      ${line}`.trimEnd()),
  ];
}

/** The report as plain text, one block per agent. */
export function renderReport(report: SplitReport): string {
  const { record, plan, live, feed, stays } = report;
  const out = [`${record.id} "${record.name}", work thread ${record.workThread}, room ${record.room}`];
  if (!plan.comm.created) {
    out.push(`  Already split: comm thread ${plan.comm.thread}. The split changes nothing.`);
    return out.join("\n");
  }
  const c = plan.comm.create;
  out.push(
    "  Changes:",
    `  - pi-host creates the comm thread "${c.name}" with ${c.model}, thinking ${c.thinkingLevel}, cwd ${c.cwd}.`,
    `  - agents.json gets comm.${record.room} = <the new thread id> on ${record.id}.`,
    `  - The comm thread's agent.ref becomes ${json(plan.commRef)}.`,
    ...role("comm thread", plan.commRef),
    `  - The work thread's agent.ref goes from ${json(plan.workRef.before)} to ${json(plan.workRef.after)}.`,
    ...role("work thread", plan.workRef.after),
    `  - The feed cursor is ${json(feed.before)} now; the feed reads the work thread from entry ${feed.drain.from} to ${feed.drain.to} once, then the comm thread from entry 0.`,
    `  - Owner posts and test sends go to the comm thread from then on.`,
  );
  if (report.sending.length) {
    out.push(`  - ${report.sending.length} posts still sending go to the comm thread on their next try:`);
    for (const p of report.sending) out.push(`    ${p.id} ${when(p.at)}, ${p.attempts} tries: ${p.text}`);
  } else out.push("  - No post is still sending.");
  out.push(
    "  Stays as it is:",
    `  - The work thread keeps its id ${record.workThread}, its history up to entry ${live.newestEntry}, its name, model and cwd.`,
    `  - The room ${record.room} keeps its posts and read mark.`,
    stays.folder.exists
      ? `  - The agent folder ${stays.folder.dir} keeps its brief and memory, and the comm thread loads them too.`
      : `  - The agent folder ${stays.folder.dir} does not exist yet, so neither thread loads a brief or memory until the agent page makes it.`,
    stays.jobs.length
      ? `  - ${stays.jobs.length} root jobs stay filed under ${record.id} with role "job" and report to the work thread: ${stays.jobs.map(j => `${j.thread} "${j.name}" (${j.status})`).join(", ")}.`
      : "  - The agent has no root jobs; jobs inside the work thread report to it as before.",
    stays.board ? `  - The board stays the work thread's chat.board: ${stays.board.steps} steps, ${stays.board.open} open, ${stays.board.todos} open todos.` : "  - The work thread has no board.",
    `  - Duties and the check-in stay in ${stays.duties.dir}: ${stays.duties.names.length ? stays.duties.names.join(", ") : "no duties"}; check-in ${stays.duties.checkIn ? json(stays.duties.checkIn) : "none"}. They keep reaching the work thread.`,
    "  Live in the work thread now:",
    `  - It is ${live.status}, with ${placeText(live.place)}.`,
    live.children.length ? `  - ${live.children.length} child conversations run: ${live.children.map(n => `${n.id} "${n.name}"`).join(", ")}.` : "  - No child conversation runs.",
  );
  return out.join("\n");
}

/** `Agents` over the data dir's files and a host that only reads, as the dry run uses them; nothing it holds writes. */
export function dryRunAgents(dataDir: string, host: Host, config: { box: string; agentsDir: string }): Agents {
  const state = { state: readJson<StateFile>(join(dataDir, "state.json"), { v: 1, threads: {}, reads: {} }) } as Pick<Store, "state"> as Store;
  return new Agents(new AgentStore(dataDir), state, readOnlyHost(host), { ...config, agentRefs: true });
}

/** Asks the server at `url` to split each agent (`POST /api/agents/:id/split {apply: true}`) and logs each answer. */
export async function applySplit(url: string, ids: readonly string[], log: (line: string) => void = console.log): Promise<void> {
  for (const id of ids) {
    const response = await fetch(`${url}/api/agents/${encodeURIComponent(id)}/split`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: true }),
    });
    const body = await response.json().catch(() => null) as { comm?: string; plan?: SplitPlan; error?: string } | null;
    if (!response.ok) log(`${id}: refused with HTTP ${response.status}: ${body?.error ?? json(body)}`);
    else log(body?.plan?.comm.created === false ? `${id}: already split, comm thread ${body.comm}` : `${id}: split, comm thread ${body?.comm}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      socket: { type: "string" },
      "agents-dir": { type: "string" },
      agent: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      url: { type: "string" },
    },
  });
  const config = readConfig([...(values["data-dir"] ? ["--data-dir", values["data-dir"]] : []), ...(values.socket ? ["--socket", values.socket] : [])]);
  const agentsDir = values["agents-dir"] ? resolve(values["agents-dir"]) : config.agentsDir;
  const host = new PiHost(config.socket);
  const agents = dryRunAgents(config.dataDir, host, { box: config.box, agentsDir });
  try {
    const records: AgentRecord[] = [];
    for (const id of values.agent ?? []) {
      const record = agents.record(id);
      if (!record) throw new Error(`no agent ${id} in ${config.dataDir}`);
      records.push(record);
    }
    if (!values.agent?.length) records.push(...agents.list().filter(a => !a.archived));
    if (values.apply) {
      if (!values.url) throw new Error("--apply needs --url of the live chat server, such as http://127.0.0.1:5184");
      await applySplit(values.url, records.map(r => r.id));
      return;
    }
    console.log(`dry run on ${config.dataDir} and ${config.socket}, ${new Date().toISOString()}; nothing is written\n`);
    for (const record of records) console.log(`${renderReport(await splitReport(agents, record))}\n`);
  } finally {
    await host.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
