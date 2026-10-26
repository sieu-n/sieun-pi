import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ownSessions } from "../../src/clean-room-subjects.ts";
import { ownedDescendants, readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";
import { senderOrigin } from "./unrelated-ci-wait.ts";

/**
 * The clean-room scenario for w81 (sieun-pi fbd5a0a0): a job the cleanup ends while its step waits is started again on the model and
 * thinking level its spawn asked for. A fresh chat gets one owner-style task whose job runs on an openai-codex model at medium thinking and
 * then waits on a message with no wake to poll, so the cleanup ends it after PARK_IDLE_MS and starts "<job> resumed HH:MM". The judge reads
 * the job's spawn record, the saved state and the resumed root's session file.
 */
export const MODEL = { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "medium" };
export const TASK = "how many test files are in components/user-history/test of ~/src/sieun-pi right now? have one job count them and put the " +
  "number on the board, on openai-codex/gpt-6-astra with medium thinking. the same job counts again after the next sieun-pi chat release " +
  "lands on this box and puts the difference on the board. the release owner will message you when it lands, so nobody needs to poll for it";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const ARTIFACTS = join(HOME, ".prime/agent/session-artifacts");
const SESSIONS = join(HOME, ".prime/agent/sessions");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const json = (file: string): Record<string, unknown> | undefined => { try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return undefined; } };

/** The first model_change and thinking_level_change of a session file. */
function head(file: string): { model?: string; thinking?: string } {
  const out: { model?: string; thinking?: string } = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n").slice(0, 12)) {
    const entry = (() => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })();
    if (entry?.type === "model_change" && out.model === undefined) out.model = `${String(entry.provider)}/${String(entry.modelId)}`;
    if (entry?.type === "thinking_level_change" && out.thinking === undefined) out.thinking = String(entry.thinkingLevel);
  }
  return out;
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const want = `${MODEL.provider}/${MODEL.modelId}`;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const children = existsSync(join(ARTIFACTS, chat)) ? readdirSync(join(ARTIFACTS, chat)).filter(name => name.startsWith("sub-")) : [];
  const spawns = children.flatMap(child => {
    const record = json(join(ARTIFACTS, chat, child, "rlm-subagent.json"));
    if (!record) return [];
    const model = record.model as { provider?: string; modelId?: string } | undefined;
    const file = typeof record.sessionFile === "string" ? record.sessionFile : "";
    return [{ child, name: String(record.sessionName ?? ""), asked: model ? `${model.provider}/${model.modelId}` : "none", ran: head(file) }];
  });
  const asked = spawns.filter(spawn => spawn.asked === want);
  add("a", asked.length ? true : null, spawns.length ? spawns.map(spawn => `${spawn.child} "${spawn.name}" asked ${spawn.asked}, ran ${spawn.ran.model ?? "?"} at ${spawn.ran.thinking ?? "?"}`).join("; ")
    : "the chat has spawned no job yet");
  const folder = join(DATA, "job-resumes", chat);
  const saved = existsSync(folder) ? readdirSync(folder).flatMap(name => { const value = json(join(folder, name)); return value ? [{ name, value }] : []; }) : [];
  const ended = saved.filter(entry => asked.some(spawn => spawn.child === entry.value.childId));
  const recorded = ended.map(entry => entry.value.model as { provider?: string; modelId?: string; thinkingLevel?: string } | undefined);
  add("b", ended.length ? recorded.every(model => model?.provider === MODEL.provider && model.modelId === MODEL.modelId) : null, ended.length
    ? ended.map((entry, at) => `${entry.name} ended ${iso(Number(entry.value.endedAt))}, steps ${JSON.stringify(entry.value.steps)}, model ${JSON.stringify(recorded[at] ?? null)}, resumed ${JSON.stringify(entry.value.resumed ?? null)}`).join("; ")
    : "the cleanup has not ended the job yet");
  const resumed = ended.flatMap(entry => { const fresh = entry.value.resumed as { id?: string; name?: string } | undefined; return fresh?.id ? [{ ...fresh, from: entry.value.childId }] : []; });
  const thinking = (child: unknown): string | undefined => asked.find(spawn => spawn.child === child)?.ran.thinking;
  const ran = resumed.map(fresh => ({ ...fresh, head: head(join(SESSIONS, `${fresh.id}.jsonl`)) }));
  add("c", ran.length ? ran.every(fresh => fresh.head.model === want && fresh.head.thinking === thinking(fresh.from)) : null, ran.length
    ? ran.map(fresh => `${fresh.id} "${fresh.name}" started on ${fresh.head.model ?? "?"} at ${fresh.head.thinking ?? "?"}; its job ${fresh.from} ran at ${thinking(fresh.from) ?? "?"}`).join("; ")
    : "no resumed job has started yet");
  // d: nobody stepped in. The chat's own sessions are its check-in jobs (runs.jsonl), the sessions the agents snapshots list under it with link
  // subagent or root (the resumed job among them) and their descendants by recorded parentage; every other sender is placed by its recorded
  // identity (`senderOrigin`), as unrelated-ci-wait places it. run3 on 10-23 read the chat's own "check-in user history test count 17 24" as outside.
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const agentDir = join(run, "agents");
  const agents = existsSync(agentDir) ? readdirSync(agentDir).flatMap(name => {
    try { const list: unknown = JSON.parse(readFileSync(join(agentDir, name), "utf8")); return Array.isArray(list) ? list as { sessionId?: string; link?: string }[] : []; } catch { return []; }
  }) : [];
  const runsFile = join(run, "runs.jsonl");
  const checkIns = existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").flatMap(line => {
    try { const entry = JSON.parse(line) as { job?: { id?: unknown } }; return typeof entry.job?.id === "string" ? [entry.job.id] : []; } catch { return []; }
  }) : [];
  const direct = ownSessions(agents, checkIns);
  const own = new Set([...direct, ...ownedDescendants([chat, ...direct], [chat, ...direct]).keys()]);
  const foreign = new Set(agents.flatMap(agent => agent.sessionId && !own.has(agent.sessionId) && agent.link !== undefined && agent.link !== "subagent" && agent.link !== "root" ? [agent.sessionId] : []));
  const placed = events.flatMap(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling")
    ? [{ event, origin: event.fromId ? senderOrigin(event.fromId, chat, own, foreign) : { kind: "unknown" as const, why: "the message records no sender session" } }] : []);
  const outside = placed.filter(({ origin }) => origin.kind === "outside");
  const unknown = placed.filter(({ origin }) => origin.kind === "unknown");
  const quoteOf = (event: { at: number; text?: string }, why = "") => `at ${iso(event.at)}: "${clip(event.text ?? "", 120)}"${why ? `; ${why}` : ""}`;
  add("d", typed.length || outside.length ? false : unknown.length ? null : true, typed.length || outside.length
    ? [...typed.map(event => quoteOf(event as { at: number; text?: string })), ...outside.map(({ event, origin }) => quoteOf(event as { at: number; text?: string }, origin.kind === "outside" ? origin.why : ""))].join("; ")
    : unknown.length ? `open: ${unknown.map(({ event, origin }) => quoteOf(event as { at: number; text?: string }, origin.kind === "unknown" ? origin.why : "")).join("; ")}`
    : "only the owner-style message, server notes and the chat's own sessions reached the chat");
  const verdict: Verdict = checks.find(check => check.id === "d")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the job's rlm-subagent.json and session file, ${folder}, and the resumed root's session file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const resumeModel: Scenario = {
  name: "resume-model",
  // The chat runs on the job's model too: run2 sat 3 h on an Anthropic account slot and never spawned its job. A resumed job that lost its
  // model would still start on the daemon default anthropic/claude-opus-5-5, which criterion c reads.
  model: { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "high" },
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
