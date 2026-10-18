import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c2 (owner 10-17: "even if i ask in Korean during chat, the actual messages sent to Jobs is in English ... i hope
 * all artifacts, actual job CoT, ... is all done in English. only the user-facing layer sees and responds in appropriate language"). A fresh
 * chat gets one ordinary task written in Korean. Its jobs' briefs, reasoning and reports must be English apart from the owner's quoted words,
 * and the chat's reply to the owner must be Korean. The criteria live in the run folder's criteria.md.
 */
export const TASK = "auto-sns-agent에서 지난 일주일 동안 CI가 실패한 run들을 원인별로 묶어서 세어 보고, 제일 많이 깨진 원인 5개를 위키 " +
  "페이지로 정리해 줘. 원인마다 대표 run 하나씩 링크해 줘";
const ARTIFACTS = join(homedir(), ".prime/agent/session-artifacts");
const HANGUL_WORD = /[\uac00-\ud7a3\u3131-\u318e]+/g;
const LATIN = /[A-Za-z]/g;
/** The owner's own words, and 메르, the name of the wiki page style that the repo skills use. */
const OWNER_WORDS = new Set([...TASK.match(HANGUL_WORD) ?? [], "메르"]);
const QUOTED = /"[^"\n]*"|“[^”]*”|`[^`\n]*`/g;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
/** The Korean words of a text outside quotes that are not the owner's own, so a quote of his message or of a Korean page for him never counts. */
const ownKorean = (text: string): string[] => (text.replace(QUOTED, " ").match(HANGUL_WORD) ?? []).filter(word => !OWNER_WORDS.has(word));
const korean = (text: string): boolean => {
  const hangul = (text.match(HANGUL_WORD) ?? []).join("").length;
  return hangul > 0 && hangul >= (text.match(LATIN) ?? []).length / 4;
};

/** Every subagent session file under the chat, at any depth, with its first incoming text (the brief) and its thinking blocks. */
function jobFiles(chat: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, depth + 1);
      else if (name.endsWith(".jsonl") && name !== "semantic-edges.jsonl" && dir.split("/").at(-1)!.startsWith("sub-")) files.push(path);
    }
  };
  walk(join(ARTIFACTS, chat), 0);
  return files;
}
interface JobRead { file: string; name: string; brief: string; thinking: { at: number; text: string }[]; sent: { at: number; text: string }[] }
function readJob(file: string): JobRead {
  const read: JobRead = { file, name: "", brief: "", thinking: [], sent: [] };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (entry.type === "session_info" && !read.name) read.name = String(entry.name ?? "");
    if (entry.type === "custom_message" && entry.customType === "agent_message" && !read.brief) read.brief = String(entry.content ?? "");
    if (entry.type !== "message") continue;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; details?: { sentAgentMessages?: { message?: string }[] } };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) if (block.type === "thinking") read.thinking.push({ at, text: String(block.thinking ?? "") });
    }
    if (message.role === "toolResult") for (const sent of message.details?.sentAgentMessages ?? []) read.sent.push({ at, text: sent.message ?? "" });
  }
  return read;
}

export const englishJobs: Scenario = {
  name: "english-jobs",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message in Korean and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat);
  const jobs = jobFiles(chat).map(readJob);
  const checks: Check[] = [];

  const briefs = jobs.map(job => ({ job, words: ownKorean(job.brief) }));
  checks.push({ id: "a", ok: jobs.length ? briefs.every(brief => brief.words.length === 0) : null, detail: jobs.length
    ? briefs.map(({ job, words }) => `${job.name}: ${words.length ? `Korean outside the owner's words: ${words.slice(0, 12).join(" ")}` : "English apart from the owner's words"}; brief starts "${clip(job.brief, 240)}"`).join("\n    ")
    : "the chat started no job yet" });

  const thoughts = jobs.flatMap(job => job.thinking.map(block => ({ job: job.name, ...block, words: ownKorean(block.text) })));
  const thoughtHits = thoughts.filter(block => block.words.length);
  checks.push({ id: "b", ok: thoughts.length ? thoughtHits.length === 0 : null, detail: `${thoughts.length} thinking blocks in ${jobs.length} jobs; ${thoughtHits.length} with Korean of their own` +
    (thoughtHits.length ? `:\n${thoughtHits.slice(0, 8).map(block => `    - ${block.job} at ${iso(block.at)}: ${block.words.slice(0, 10).join(" ")}`).join("\n")}` : "") });

  const reports = jobs.flatMap(job => job.sent.map(sent => ({ job: job.name, ...sent, words: ownKorean(sent.text) })));
  checks.push({ id: "c", ok: reports.length ? reports.every(report => report.words.length === 0) : null, detail: reports.length
    ? reports.map(report => `${report.job} at ${iso(report.at)}: ${report.words.length ? `Korean: ${report.words.slice(0, 10).join(" ")}` : "English"}; "${clip(report.text, 240)}"`).join("\n    ")
    : "no job sent a report yet" });

  const told = events.flatMap(event => event.kind === "call" && event.tool === "tell_owner" ? [{ at: event.at, text: String((JSON.parse(event.input) as { text?: string }).text ?? "") }] : []);
  checks.push({ id: "d", ok: told.length ? told.every(reply => korean(reply.text)) : null, detail: told.length
    ? told.map(reply => `${iso(reply.at)} ${korean(reply.text) ? "Korean" : "not Korean"}: "${clip(reply.text, 240)}"`).join("\n    ")
    : "the chat has not replied yet" });

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") && !state.seeds.some(seed => event.text.includes(seed)));
  const outside = events.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child" && !/^check-in /.test(event.from ?? ""));
  checks.push({ id: "e", ok: typed.length === 0 && outside.length === 0, detail: typed.length || outside.length
    ? [...typed.map(event => `typed at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`), ...outside.map(event => `message from ${event.kind === "text" ? event.from : ""}`)].join("; ")
    : "only the owner-style message, server notes, the chat's check-ins and its own jobs reached the chat" });

  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file and ${jobs.length} job session files under ${join(ARTIFACTS, chat)}.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
