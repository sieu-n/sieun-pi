import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findSends, readSends, recordSend, sendLogPath, sessionOf, type SendDecision, type SendEntry, type SendQuery } from "../../global-rules/send-log.ts";

/*
 * Reads the record of outside sends (c37) and fills it from older transcripts. The guard layers write the live lines
 * (components/global-rules/send-log.ts). backfill() replays each bash and ipython call in the saved session transcripts through
 * the same send rules: the tool_call guard's (global-rules guard.ts) and the aside-browser skill's page check. A call that would
 * be refused today and ran then is a "ran" line, so a chat that asks "did an agent send X anything" finds the sends made before
 * the guard existed. CLI:
 *   node --import tsx components/user-history/src/send-log.ts [--since 2026-10-08] [--match iwebfusion] [--chat <id>] [--decision ran]
 *   node --import tsx components/user-history/src/send-log.ts backfill [--since 2026-10-08]
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ASIDE_SRC = join(REPO, "skills", "aside-browser", "src");

type Judged = { rule: string; command: string; reason: string }[];
/** The send rules of the tool_call guard, without its git and merge rules, which run git for each git command they read. */
export interface GuardModule {
  judgeSendShell(text: string, cwd: string): Judged;
  judgeSendPython(code: string): Judged;
  extractShellCandidates(code: string): { text: string }[];
  judgeCuaShell(text: string): Judged;
}

interface Call {
  id: string;
  tool: string;
  text: string;
  at: string;
  line: number;
}

interface Found {
  call: Call;
  reason: string;
  target: string;
}

/** Every saved session transcript under the agent dir changed since `since`: sessions/<id>.jsonl and each job's file under session-artifacts. */
export function transcripts(agentDir: string, since: string): string[] {
  const cutoff = Date.parse(since);
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name.endsWith(".jsonl")) {
        if (name === "semantic-edges.jsonl") continue;
        try {
          if (statSync(path).mtimeMs >= cutoff) out.push(path);
        } catch {
          // A file removed mid-walk is skipped.
        }
      } else if (depth < 8 && !name.includes(".")) {
        walk(path, depth + 1);
      }
    }
  };
  walk(join(agentDir, "sessions"), 7);
  walk(join(agentDir, "session-artifacts"), 0);
  return out.sort();
}

const URL_IN_CODE = /(?:open_tab|goto|openTab)\(\s*f?["'`](https?:\/\/[^"'`\s]+)/g;
const URL_IN_RESULT = /"(?:url|u)"\s*:\s*"(https?:\/\/[^"\s]+)"/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const REFUSED = /Refused:|send guard: refused|merge guard: refused/;
const ASIDE_CALL = /\baside_browser\b|\baside\b.*\b(?:repl|exec)\b/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** The aside-browser skill's cell_sends() over each (cell, page URL) pair, in one Python process. */
function asideSends(items: { code: string; url: string }[]): (string | null)[] {
  if (!items.length) return [];
  const python = existsSync(join(REPO, ".venv", "bin", "python")) ? join(REPO, ".venv", "bin", "python") : "python3";
  const script = "import json, sys\nsys.path.insert(0, sys.argv[1])\nimport aside_browser as ab\n" +
    "print(json.dumps([ab.cell_sends(i['code'], i['url']) for i in json.load(sys.stdin)]))";
  const proc = spawnSync(python, ["-B", "-c", script, ASIDE_SRC], { input: JSON.stringify(items), encoding: "utf8", maxBuffer: 1 << 28 });
  if (proc.status !== 0) throw new Error(`aside_browser send check failed: ${proc.stderr.slice(-2000)}`);
  return JSON.parse(proc.stdout) as (string | null)[];
}

interface Scan {
  file: string;
  cwd: string;
  sessionId: string | null;
  calls: Call[];
  /** Each call's tool result: its text (cut to 4,000 chars), whether it errored, and when it came back. */
  results: Map<string, { text: string; error: boolean; at: string }>;
  /** For each aside-browser call: the page it ran on and the addresses that page showed, as far as the transcript tells. */
  pages: Map<string, { url: string; emails: string[] }>;
}

/** The OWNER_OK token a call carries: a literal, or a variable an earlier cell of the same transcript set to one. */
function ownerOkOf(scan: Scan, call: Call): string | null {
  const literal = call.text.match(/\bOWNER_OK["']?\s*[=:]\s*f?["']?([\w-]+\/[\w-]+)/i)?.[1];
  if (literal) return literal;
  const name = call.text.match(/\bowner_ok\s*=\s*([A-Za-z_]\w*)/)?.[1];
  if (!name || name === "None") return null;
  const set = new RegExp(`\\b${name}\\s*=\\s*f?["']([\\w-]+\\/[\\w-]+)["']`);
  for (const earlier of scan.calls.slice(0, scan.calls.indexOf(call) + 1).reverse()) {
    const found = earlier.text.match(set)?.[1];
    if (found) return found;
  }
  return null;
}

/** The bash and ipython calls in one transcript, with their results and the Aside page each browser call ran on. */
export function readTranscript(file: string): Scan {
  const scan: Scan = { file, cwd: homedir(), sessionId: null, calls: [], results: new Map(), pages: new Map() };
  let page = { url: "", emails: new Set<string>() };
  readFileSync(file, "utf8").split("\n").forEach((raw, index) => {
    if (!raw.includes('"toolCall"') && !raw.includes('"toolResult"') && !raw.includes('"type":"session"')) return;
    let entry: { type?: string; id?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
    try {
      entry = JSON.parse(raw);
    } catch {
      return;
    }
    if (entry.type === "session") {
      scan.cwd = entry.cwd ?? scan.cwd;
      scan.sessionId = entry.id ?? null;
      return;
    }
    const message = entry.message;
    if (!message) return;
    if (message.role === "toolResult" && message.toolCallId) {
      const text = textOf(message.content);
      scan.results.set(message.toolCallId, { text: text.slice(0, 4000), error: message.isError === true, at: entry.timestamp ?? "" });
      if (scan.pages.has(message.toolCallId)) {
        for (const m of text.matchAll(URL_IN_RESULT)) page.url = m[1] ?? page.url;
        for (const m of text.matchAll(EMAIL)) page.emails.add(m[0]);
      }
      return;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const part of message.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
      if (part.type !== "toolCall" || (part.name !== "bash" && part.name !== "ipython") || !part.id) continue;
      const text = String((part.name === "bash" ? part.arguments?.command : part.arguments?.code) ?? "");
      scan.calls.push({ id: part.id, tool: part.name, text, at: entry.timestamp ?? "", line: index + 1 });
      if (part.name === "ipython" && ASIDE_CALL.test(text)) {
        const opened = [...text.matchAll(URL_IN_CODE)].at(-1)?.[1];
        if (opened) page = { url: opened, emails: new Set() };
        scan.pages.set(part.id, { url: page.url, emails: [...page.emails] });
      }
    }
  });
  return scan;
}

/** The send calls in these transcripts, judged by today's rules, with the outcome each tool result shows. One Python process judges every browser call. */
export function judgeTranscripts(scans: Scan[], guard: GuardModule, since = "", until = "\uffff"): SendEntry[] {
  const inRange = (call: Call) => call.at >= since && call.at < until;
  const aside = scans.flatMap((scan) => scan.calls.filter((call) => inRange(call) && scan.pages.has(call.id)).map((call) => ({ scan, call })));
  const asideReasons = asideSends(aside.map(({ scan, call }) => ({ code: call.text, url: scan.pages.get(call.id)?.url ?? "" })));
  const found: (Found & { scan: Scan })[] = [];
  aside.forEach(({ scan, call }, i) => {
    const reason = asideReasons[i];
    if (!reason) return;
    const seen = scan.pages.get(call.id)!;
    const emails = new Set([...seen.emails, ...(call.text.match(EMAIL) ?? []), ...(scan.results.get(call.id)?.text.match(EMAIL) ?? [])]);
    found.push({ scan, call, reason, target: [seen.url || "(page not in transcript)", emails.size ? `to ${[...emails].join(", ")}` : ""].filter(Boolean).join(" | ") });
  });
  for (const scan of scans) {
    for (const call of scan.calls.filter(inRange)) {
      let judged: Judged;
      try {
        const shell = (text: string): Judged => [...guard.judgeSendShell(text, scan.cwd), ...(text.includes("cua-driver") ? guard.judgeCuaShell(text) : [])];
        judged = (call.tool === "bash" ? shell(call.text) : [...guard.extractShellCandidates(call.text).flatMap((c) => shell(c.text)), ...guard.judgeSendPython(call.text)]).filter((v) => v.rule === "send");
      } catch {
        continue;
      }
      for (const v of judged) found.push({ scan, call, reason: v.reason.replace(/^[\w -]*send guard: refused, because /, "").split(/\.\s+(?=[A-Z])/)[0] ?? v.reason, target: v.command.slice(0, 400) });
    }
  }
  return found.map(({ scan, call, reason, target }) => {
    const result = scan.results.get(call.id);
    const decision: SendDecision = !result ? "failed" : REFUSED.test(result.text) ? "refused" : result.error ? "failed" : "ran";
    const token = ownerOkOf(scan, call);
    const where = sessionOf(scan.file);
    return { at: result?.at || call.at, decision, layer: "transcript" as const, chat: where.chat, session: where.session ?? scan.sessionId, target, reason, ownerOk: token, where: `${scan.file}:${call.line}` };
  });
}

export async function loadGuard(): Promise<GuardModule> {
  // Loaded by URL so this package's stricter tsconfig does not type-check global-rules, which the root tsconfig owns.
  const load = async (name: string) => (await import(pathToFileURL(join(REPO, "components", "global-rules", name)).href)) as Record<string, unknown>;
  const [guard, send, cua] = await Promise.all([load("guard.ts"), load("send-guard.ts"), load("cua-guard.ts")]);
  return { ...guard, ...send, ...cua } as unknown as GuardModule;
}

/**
 * Adds the sends found in transcripts changed since `since` to the log, up to the first live line (the guards log from then on).
 * A call already in the log (the same where) is not added again, so a second run adds nothing.
 */
export async function backfill(options: { agentDir?: string; since: string; logPath?: string; until?: string }): Promise<SendEntry[]> {
  const agentDir = options.agentDir ?? join(homedir(), ".prime", "agent");
  const logPath = options.logPath ?? sendLogPath();
  const known = readSends(logPath);
  const firstLive = known.find((entry) => entry.layer !== "transcript")?.at;
  const until = options.until ?? firstLive ?? new Date().toISOString();
  const have = new Set(known.map((entry) => `${entry.where}|${entry.target}`));
  const guard = await loadGuard();
  const added: SendEntry[] = [];
  const scans: Scan[] = [];
  for (const file of transcripts(agentDir, options.since)) {
    try {
      scans.push(readTranscript(file));
    } catch (error) {
      process.stderr.write(`send-log: skipped ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  for (const entry of judgeTranscripts(scans, guard, options.since, until)) {
    const key = `${entry.where}|${entry.target}`;
    if (have.has(key)) continue;
    have.add(key);
    recordSend(entry, logPath);
    added.push(entry);
  }
  return added;
}

export function formatSends(entries: SendEntry[], query: SendQuery = {}): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.decision, (counts.get(entry.decision) ?? 0) + 1);
  const summary = [...counts].map(([decision, n]) => `${n} ${decision}`).join(", ") || "none";
  const scope = [query.since && `since ${query.since}`, query.match && `matching "${query.match}"`, query.chat && `in chat ${query.chat}`, query.decision && `decided ${query.decision}`].filter(Boolean).join(", ");
  const head = `${entries.length} outside send${entries.length === 1 ? "" : "s"} in ${sendLogPath()}${scope ? ` ${scope}` : ""}: ${summary}.`;
  return [head, ...entries.map((e) => `${e.at} ${e.decision} ${e.layer} chat=${e.chat ?? "?"} session=${e.session ?? "?"} ok=${e.ownerOk ?? "none"} :: ${e.target} (${e.reason})${e.where ? ` @ ${e.where}` : ""}`)].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "backfill") {
    const added = await backfill({ since: flag(args, "since") ?? "2026-10-08T00:00:00Z" });
    process.stdout.write(`${formatSends(added)}\n`);
  } else {
    const query: SendQuery = {};
    for (const key of ["since", "until", "match", "chat"] as const) {
      const value = flag(args, key);
      if (value) query[key] = value;
    }
    const decision = flag(args, "decision");
    if (decision) query.decision = decision as SendDecision;
    process.stdout.write(`${formatSends(findSends(readSends(), query), query)}\n`);
  }
}
