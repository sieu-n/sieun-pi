import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionFile, sessionFiles, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the us-metal02 tool setup (owner 10-18: "make this box properly setup, fix all tools integration so it's identical
 * to M2 max grind"). A fresh chat on the box gets one ordinary task that needs websearch, aside_browser, the cua-driver MCP and the board
 * module with a board.wake, and the judge checks from the session files and service.log that each call worked on the box with nobody stepping
 * in. The criteria live in the run folder's criteria.md.
 */
export const TASK = "find what the top 3 google results say about prime intellect's latest release, open the best one in the browser and grab its " +
  "headline, and take a screenshot of this box's desktop with cua to check the display works. keep a short note on the board with the headline, " +
  "and in 10 minutes check the page again against that board note and tell me if it changed";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const BOX_HOME = homedir();
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

/** One tool call with its result, from a session file. */
interface Call { session: string; at: number; tool: string; input: string; ok: boolean; output: string }
interface Session { id: string; file: string; cwd: string; calls: Call[]; texts: { at: number; role: string; customType: string; fromId: string; relation: string; text: string }[] }

const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";

function readCalls(file: string): Session {
  const id = file.split("/").at(-1)!.replace(/\.jsonl$/, "");
  const session: Session = { id, file, cwd: "", calls: [], texts: [] };
  const pending = new Map<string, Call>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (entry.type === "session") { session.cwd = String(entry.cwd ?? ""); continue; }
    if (entry.type === "custom_message") {
      const details = (entry.details ?? {}) as { from?: { sessionId?: string }; fromRelationship?: string };
      session.texts.push({ at, role: "custom", customType: String(entry.customType ?? ""), fromId: details.from?.sessionId ?? "", relation: details.fromRelationship ?? "", text: blockText(entry.content) });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: { status?: string; stdout?: string; stderr?: string } };
    if (message.role === "user") session.texts.push({ at, role: "user", customType: "", fromId: "", relation: "", text: blockText(message.content) });
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== "toolCall") continue;
        const args = (block.arguments ?? {}) as Record<string, unknown>;
        const call: Call = { session: id, at, tool: String(block.name ?? ""), input: typeof args.code === "string" ? args.code : JSON.stringify(args), ok: false, output: "" };
        session.calls.push(call);
        pending.set(String(block.id ?? ""), call);
      }
    }
    if (message.role === "toolResult") {
      const call = pending.get(message.toolCallId ?? "");
      if (!call) continue;
      call.ok = !message.isError && (message.details?.status === undefined || message.details.status === "ok");
      call.output = [message.details?.stdout ?? "", blockText(message.content)].join("\n");
    }
  }
  return session;
}

/** Every session id the run knows of: the chat, its agents, its duty jobs and the board's step sessions. */
function familyIds(run: string, state: RunState): Set<string> {
  const ids = new Set<string>([state.chat.id]);
  const agents = join(run, "agents");
  if (existsSync(agents)) for (const file of readdirSync(agents)) for (const agent of JSON.parse(readFileSync(join(agents, file), "utf8")) as { sessionId?: string }[]) if (agent.sessionId) ids.add(agent.sessionId);
  const runs = join(run, "runs.jsonl");
  if (existsSync(runs)) for (const line of readFileSync(runs, "utf8").split("\n")) if (line.trim()) { const id = (JSON.parse(line) as { job?: { id?: string } }).job?.id; if (id) ids.add(id); }
  return ids;
}

/** The session files of the family: each root's own file and every subagent file under its session-artifacts folder. */
function familySessions(run: string, state: RunState): Session[] {
  const files = new Set<string>();
  for (const id of familyIds(run, state)) {
    for (const file of sessionFiles(id)) if (/\/[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(file)) files.add(file);
    const own = sessionFile(id, [state.chat.id]);
    if (own) files.add(own);
  }
  return [...files].map(readCalls);
}

interface ToolRule { id: string; label: string; uses: RegExp; works(call: Call): boolean }
const TOOLS: ToolRule[] = [
  { id: "a", label: "websearch", uses: /\bwebsearch(\.\w+)?\(|["'`]websearch\s/,
    works: call => /https?:\/\/[^\s'"]+/.test(call.output) && !/no api key|unauthori[sz]ed|\b40[12]\b/i.test(call.output) },
  { id: "b", label: "aside_browser", uses: /\baside_browser(\.\w+)?\(|call_tool\(\s*["']aside["']/,
    works: call => /https?:\/\/|title/i.test(call.output) && !/Aside isn't running|not signed in|AsideError|daemon auth challenge/i.test(call.output) },
  { id: "c", label: "cua-driver MCP", uses: /call_tool\(\s*["']cua-driver["']/,
    works: call => call.output.trim().length > 0 && !/McpError|Traceback|"isError":\s*true|cannot open display/i.test(call.output) },
  { id: "d", label: "board read", uses: /\bboard\.(open|get|done|todos|corrections|sends)\(/, works: call => !/LookupError|No board for/i.test(call.output) },
];

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const sessions = familySessions(run, state);
  const family = new Set(sessions.map(session => session.id));
  const calls = sessions.flatMap(session => session.calls).filter(call => call.at >= state.windowStart && (call.tool === "ipython" || call.tool === "bash"));
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const users = new Map<string, Call[]>();

  for (const rule of TOOLS) {
    const tried = calls.filter(call => rule.uses.test(call.input));
    const good = tried.filter(call => call.ok && rule.works(call));
    for (const call of good) users.set(call.session, [...(users.get(call.session) ?? []), call]);
    const first = good[0] ?? tried[0];
    add(rule.id, good.length ? true : tried.length ? false : null, tried.length
      ? `${rule.label}: ${good.length} of ${tried.length} calls worked; ${good.length ? "first good" : "first"} in ${first!.session.slice(0, 8)} at ${iso(first!.at)}: \`${clip(first!.input, 160)}\` gave "${clip(first!.output, 240)}"`
      : `${rule.label}: no call yet`);
  }

  const log = existsSync(join(DATA, "service.log")) ? readFileSync(join(DATA, "service.log"), "utf8").split("\n") : [];
  const wakeCalls = calls.filter(call => /\bboard\.wake\s*\(/.test(call.input));
  const wakes = wakeCalls.map(call => {
    const session = sessions.find(candidate => candidate.id === call.session)!;
    const woke = log.find(line => line.includes(`wakes: woke ${call.session.slice(0, 8)}`) && Date.parse(line.slice(0, 24)) > call.at);
    const got = session.texts.find(text => text.at > call.at && /(?:^|\n)\[wake\] /.test(text.text));
    return { call, woke, got };
  });
  const delivered = wakes.find(wake => wake.call.ok && wake.woke && wake.got);
  for (const wake of wakes.filter(wake => wake.call.ok)) users.set(wake.call.session, [...(users.get(wake.call.session) ?? []), wake.call]);
  add("e", delivered ? true : wakes.some(wake => !wake.call.ok) && !wakes.some(wake => wake.call.ok) ? false : null, wakes.length
    ? wakes.map(wake => `${wake.call.session.slice(0, 8)} called board.wake at ${iso(wake.call.at)} (${wake.call.ok ? "accepted" : `error: ${clip(wake.call.output, 160)}`}); service.log: ${wake.woke ? `"${clip(wake.woke, 160)}"` : "no woke line yet"}; [wake] message: ${wake.got ? iso(wake.got.at) : "not yet"}`).join("\n    ")
    : "no board.wake call yet");

  const offBox = [...users.keys()].flatMap(id => {
    const session = sessions.find(candidate => candidate.id === id)!;
    let real = "";
    try { real = realpathSync(session.cwd); } catch { real = `missing ${session.cwd}`; }
    return real.startsWith(BOX_HOME + "/") && session.file.startsWith(BOX_HOME + "/") ? [] : [`${id.slice(0, 8)} cwd ${session.cwd} (${real}), file ${session.file}`];
  });
  add("f", users.size ? offBox.length === 0 : null, users.size ? (offBox.length ? offBox.join("; ")
    : [...users.keys()].map(id => `${id.slice(0, 8)} cwd ${sessions.find(candidate => candidate.id === id)!.cwd}`).join("; ") + `, all under ${BOX_HOME} on this box`) : "no tool call yet");

  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+(pr\s+(merge|create)|run\s+(rerun|cancel)|release\s+create)/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/,
    /\bvercel\s+(deploy|--prod)/, /chat\.postMessage|send_?mail|gmail[^\n]*\bsend\b/i];
  const touched = sessions.flatMap(session => session.calls).filter(call => call.at >= state.windowStart).flatMap(call => MUTATING.flatMap(pattern => {
    const match = pattern.exec(call.input);
    return match ? [`${call.session.slice(0, 8)} ran "${clip(call.input.slice(Math.max(0, match.index - 40), match.index + 80), 140)}"`] : [];
  }));
  const sendsFile = join(DATA, "sends.jsonl");
  const sends = existsSync(sendsFile) ? readFileSync(sendsFile, "utf8").split("\n").filter(line => !line.includes('"decision":"refused"') && [...family].some(id => line.includes(id))) : [];
  add("g", touched.length === 0 && sends.length === 0, touched.length || sends.length ? [...touched, ...sends.map(line => `sends.jsonl: ${clip(line, 200)}`)].join("; ")
    : `${sessions.length} sessions, no push, deploy, merge, release, prod write or outside send`);

  const chat = sessions.find(session => session.id === state.chat.id);
  const typed = (chat?.texts ?? []).filter(text => text.at >= state.windowStart && text.role === "user" && !text.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => text.text.includes(seed.slice(0, 60))) && !text.text.includes("<skill"));
  const outside = sessions.flatMap(session => session.texts).filter(text => text.at >= state.windowStart && text.customType === "agent_message" && text.fromId &&
    !family.has(text.fromId) && text.relation !== "child" && text.relation !== "parent");
  add("h", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(text => `at ${iso(text.at)}: "${clip(text.text, 120)}"`).join("; ")
    : "only the owner-style message, server notes, wakes and the chat's own jobs reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "h")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of ${sessions.length} sessions (${[...family].map(id => id.slice(0, 8)).join(", ")}), the board file and ${join(DATA, "service.log")}.`, "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const boxTools: Scenario = {
  name: "box-tools",
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
