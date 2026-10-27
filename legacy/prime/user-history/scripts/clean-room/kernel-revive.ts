import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { messageCheckPrelude } from "../../src/message-limit-check.ts";
import { readSession, sessionFiles, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for message-limit-check.py VERSION 10. On 10-16 chat 01a14210 came back from an archive with `[python-state-restored]`,
 * and agent_observe raised "attempted relative import with no known parent package", because the kernel snapshot had pickled rlm's own
 * host_request by value. A fresh chat gets an ordinary task for a job. Once it has answered and sat idle until its worker stops on its own, the
 * owner's second message asks for more, so the chat comes back with a revived kernel. Nobody tells it anything about kernels. The criteria live
 * in the run folder's criteria.md.
 */
export const TASK = "have a job count how many test files legacy/prime/user-history has and how many of them start a python process. give me both numbers";
export const FOLLOW_UP = "nice. now have a job count the same for packages/pi-pool, and tell me what the first job's last message said";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const ARTIFACTS = join(HOME, ".prime/agent/session-artifacts");
const PYTHON = join(process.env.PRIME_AGENT_KERNEL_VENV || join(HOME, ".prime/agent/kernel-venv"), "bin/python");
const RELATIVE = "attempted relative import with no known parent package";

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

/** The ipython results of a session file after `since`, with their text. */
function results(file: string, since: number): { at: number; text: string }[] {
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    if (!line.includes("\"toolResult\"")) return [];
    const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string; toolName?: string; content?: { text?: string }[] } };
    const at = Date.parse(entry.timestamp ?? "");
    if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.toolName !== "ipython" || !(at > since)) return [];
    return [{ at, text: (entry.message.content ?? []).map(block => block.text ?? "").join("\n") }];
  });
}

/** Revives a copy of the chat's saved kernel state in a fresh Prime kernel, restore first and prelude second as at a worker start, and calls each module's host_request. */
export function reviveSnapshot(chat: string): { ok: boolean | null; detail: string; dataDir?: string | null } {
  const saved = join(ARTIFACTS, chat, "kernel-state.dill");
  if (!existsSync(saved)) return { ok: null, detail: `no ${saved} yet` };
  if (!existsSync(PYTHON)) return { ok: null, detail: `no Prime kernel at ${PYTHON}` };
  const dir = mkdtempSync(join(tmpdir(), "revive-check-"));
  copyFileSync(saved, join(dir, "kernel-state.dill"));
  const script = [
    "import asyncio, json, types, rlm, rlm.repl as repl",
    `ns = {}`,
    `result = repl._restore_state(ns, ${JSON.stringify(join(dir, "kernel-state.dill"))})`,
  ].join("\n") + "\n" + messageCheckPrelude(DATA) + [
    "async def host(req): return {'status': 'ok', 'result': {'type': req['type']}}",
    "repl.host_request = host",
    "async def main():",
    "    out = {'failed': [item['name'] for item in result.get('failed', [])], 'calls': {}}",
    "    held = getattr(ns.get('agent_message'), 'host_request', None)",
    "    out['dataDir'] = getattr(held, '__globals__', {}).get('DATA_DIR')",
    "    for name, value in sorted(ns.items()):",
    "        if isinstance(value, types.ModuleType) and 'host_request' in vars(value):",
    "            try:",
    "                out['calls'][name] = (await value.host_request('agent_observe.list_agents', {}))['type']",
    "            except Exception as error:",
    "                out['calls'][name] = f'{type(error).__name__}: {error}'",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  const run = spawnSync(PYTHON, ["-c", script], { cwd: dir, encoding: "utf8" });
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  if (run.status !== 0 || !last.startsWith("{")) return { ok: false, detail: `the revive script exited ${run.status}: ${clip(run.stderr, 400)}` };
  const out = JSON.parse(last) as { failed: string[]; calls: Record<string, string>; dataDir: string | null };
  const bad = Object.entries(out.calls).filter(([, value]) => value !== "agent_observe.list_agents");
  const needed = ["agent_message", "agent_observe"].filter(name => !(name in out.calls));
  return { dataDir: out.dataDir, ok: bad.length === 0 && needed.length === 0, detail: `${Object.keys(out.calls).length} restored modules hold host_request: ` +
    Object.entries(out.calls).map(([name, value]) => `${name} ${value === "agent_observe.list_agents" ? "reached the host" : `raised ${clip(value, 120)}`}`).join(", ") +
    `${needed.length ? `; missing ${needed.join(", ")}` : ""}; restore failures: ${out.failed.join(", ") || "none"}` };
}

export const kernelRevive: Scenario = {
  name: "kernel-revive",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "`clean-room.ts say` sends the owner's second message through POST api/threads/<id>/prompt, the composer's route, once the chat answered and its worker stopped on its own.", "",
    "## The messages", "", `> ${TASK}`, "", `> ${FOLLOW_UP}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat);
  const checks: Check[] = [];
  const asked = events.find(event => event.kind === "text" && event.role === "user" && event.text.includes(FOLLOW_UP));
  // Prime writes the notice a few ms before the message that woke the worker, so the revive is the first notice after the chat's last reply before it.
  const lastReply = asked ? events.filter(event => event.kind === "assistant" && event.at < asked.at).at(-1)?.at ?? 0 : 0;
  const revive = asked && events.find(event => event.kind === "text" && event.customType === "ipython_state_restored" && event.at > lastReply);
  const reviveText = revive && revive.kind === "text" ? revive.text : "";
  const reviveAt = revive ? revive.at : Infinity;
  checks.push({ id: "a", ok: asked ? (revive ? /\bagent_observe\b/.test(reviveText) && /\bagent_message\b/.test(reviveText) : null) : null,
    detail: !asked ? "the second message has not been sent yet" : revive ? `${iso(revive.at)}: "${clip(reviveText, 400)}"` : "no [python-state-restored] notice after the second message yet" });

  const files = sessionFiles(chat);
  const hits = files.flatMap(file => readFileSync(file, "utf8").split("\n").filter(line => line.includes(RELATIVE) && Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "") >= state.windowStart)
    .map(line => `${file.split("/").at(-1)} at ${/"timestamp":"([^"]+)"/.exec(line)?.[1]}`));
  checks.push({ id: "b", ok: hits.length === 0, detail: hits.length ? hits.join("; ") : `none in ${files.length} session files` });

  const after = revive ? results(join(HOME, ".prime/agent/sessions", `${chat}.jsonl`), reviveAt) : [];
  const broken = after.filter(result => /Traceback/.test(result.text) && /host_request/.test(result.text));
  const calls = events.filter(event => event.kind === "call" && event.tool === "ipython" && event.at >= reviveAt && /rlm\.spawn\(|agent_message\.|agent_observe\./.test(event.input));
  checks.push({ id: "c", ok: revive ? (broken.length ? false : calls.length ? true : null) : null, detail: !revive ? "no revive yet"
    : `${calls.length} cells after the revive call rlm.spawn, agent_message or agent_observe; ${broken.length ? broken.map(result => `${iso(result.at)} "${clip(result.text, 300)}"`).join("; ") : "no host_request traceback"}` });

  // The brief keeper drops a record once its job starts (briefTick, act "drop"), so a finished run keeps none. The lasting evidence is the
  // data folder the revived agent_message.host_request carries, read in (e)'s revive.
  const snapshot = revive ? reviveSnapshot(chat) : { ok: null, detail: "no revive yet" } as ReturnType<typeof reviveSnapshot>;
  const spawned = events.filter(event => event.kind === "call" && event.tool === "ipython" && event.at >= reviveAt && /rlm\.spawn\(/.test(event.input));
  checks.push({ id: "d", ok: revive ? (snapshot.dataDir === undefined ? null : snapshot.dataDir === DATA && spawned.length > 0) : null,
    detail: `${spawned.length} rlm.spawn cells after the revive; the revived agent_message.host_request carries DATA_DIR ${JSON.stringify(snapshot.dataDir ?? null)}, the service's is ${DATA}` });

  checks.push({ id: "e", ok: snapshot.ok, detail: snapshot.detail });

  const answer = events.filter(event => event.at > reviveAt && (event.kind === "assistant" || (event.kind === "call" && event.tool === "tell_owner"))).at(-1);
  const answerText = !answer ? "" : answer.kind === "assistant" ? answer.text : answer.kind === "call" ? String((JSON.parse(answer.input) as { text?: string }).text ?? "") : "";
  checks.push({ id: "f", ok: revive ? (answer && /\d/.test(answerText) ? true : null) : null, detail: answer ? `${iso(answer.at)}: "${clip(answerText, 400)}"` : "no answer after the revive yet" });

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") && !state.seeds.some(seed => event.text.includes(seed)));
  const outside = events.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child");
  checks.push({ id: "g", ok: typed.length === 0 && outside.length === 0, detail: typed.length || outside.length
    ? [...typed.map(event => `typed at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`), ...outside.map(event => `message from ${event.kind === "text" ? event.from : ""}`)].join("; ")
    : "only the owner-style messages, server notes and the chat's own jobs reached the chat" });

  const verdict: Verdict = checks.find(check => check.id === "g")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session files, ${join(ARTIFACTS, chat, "kernel-state.dill")}, revived in a fresh Prime kernel.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
