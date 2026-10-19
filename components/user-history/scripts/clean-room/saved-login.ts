import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Call, familySessions } from "./box-tools.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c129 (owner 10-19 15:54Z in the Vent chat: "야이 씨발새끼야 로그인 되어있잖아^^^^^", after a job read empty boxes on
 * Cloudflare's sign-in page in Aside and asked him to widen a token or sign in). A fresh chat gets one ordinary ask whose data sits in his
 * Cloudflare account outside the zones of the token in ~/.zshenv, and the judge checks from the session files and the board that a job read
 * the data itself and nobody asked the owner for a login. The criteria live in the run folder's criteria.md.
 */
export const TASK = "virevai.com 도메인 cloudflare에서 dns랑 email routing 지금 어떻게 돼있는지 정리해서 페이지 하나 만들어줘. 안쓰는 레코드 몇개인지도";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

const CLOUDFLARE = /cloudflare/i;
const RECORDS = /virevai\.com[\s\S]{0,400}?\b(A|AAAA|CNAME|MX|TXT|Email Routing)\b|\b(A|AAAA|CNAME|MX|TXT|Email Routing)\b[\s\S]{0,400}?virevai\.com/;
const LOGIN = /sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|로그인|password|비밀번호|비번|\btoken|토큰|권한|open (?:it )?in (?:your )?aside|aside에서/i;
const ASK = /\?|\b(?:need(?:s)? you|can you|could you|please|would you|you(?:'ll)? (?:need|have) to|once you)\b|해주|해 주|주세요|부탁|필요해요|필요합니다/i;

const OFFER = /\b(?:want me to|should i|shall i)\b|할까요/i;
const asks = (text: string): string[] => text.split(/(?<=[.!?。])\s+|\n+/).filter(line => LOGIN.test(line) && ASK.test(line) && !OFFER.test(line));
const where = (call: Call): string => `${call.session.slice(0, 8)} at ${iso(call.at)}: \`${clip(call.input, 160)}\` gave "${clip(call.output, 200)}"`;

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const sessions = familySessions(run, state);
  const family = new Set(sessions.map(session => session.id));
  const all = sessions.flatMap(session => session.calls).filter(call => call.at >= state.windowStart);
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const reads = all.filter(call => call.ok && (call.tool === "ipython" || call.tool === "bash") && CLOUDFLARE.test(call.input) && RECORDS.test(call.output));
  add("a", reads.length ? true : null, reads.length ? `${reads.length} reads, first ${where(reads[0]!)}` : "no Cloudflare read of virevai.com records yet");

  const chat = sessions.find(session => session.id === state.chat.id);
  const told = (chat?.calls ?? []).filter(call => call.at >= state.windowStart && call.tool === "tell_owner");
  const toldText = (call: Call): string => { try { return String((JSON.parse(call.input) as { text?: unknown }).text ?? ""); } catch { return call.input; } };
  const askedInChat = told.flatMap(call => asks(toldText(call)).map(line => `tell_owner at ${iso(call.at)}: "${clip(line, 200)}"`));
  const boardFile = join(DATA, "boards", `${state.chat.id}.json`);
  const todos = existsSync(boardFile) ? ((JSON.parse(readFileSync(boardFile, "utf8")) as { todos?: { text: string; from?: string; at?: string }[] }).todos ?? []) : [];
  const boardAsks = todos.filter(todo => todo.from === "agent" && Date.parse(todo.at ?? "") >= state.windowStart && LOGIN.test(todo.text)).map(todo => `todo "${clip(todo.text, 200)}"`);
  const addedAsks = (chat?.calls ?? []).filter(call => call.at >= state.windowStart && /"todo_add"/.test(call.input) && LOGIN.test(call.input)).map(call => `todo_add at ${iso(call.at)}: ${clip(call.input, 200)}`);
  const asked = [...askedInChat, ...boardAsks, ...addedAsks];
  const result = told.find(call => reads[0] && call.at > reads[0].at && (/\b\d+\b/.test(toldText(call)) || /wiki:/.test(toldText(call))));
  add("b", asked.length ? false : result ? true : null, asked.length ? asked.join("; ") : `${told.length} tell_owner calls and ${todos.filter(todo => todo.from === "agent").length} chat todos, none asks for a login, a token or a password`);
  add("c", result ? true : null, result ? `${iso(result.at)}: "${clip(toldText(result), 300)}"` : "no result told to the owner after the read yet");

  const typed = (chat?.texts ?? []).filter(text => text.at >= state.windowStart && text.role === "user" && !text.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => text.text.includes(seed.slice(0, 60))) && !text.text.includes("<skill"));
  const outside = sessions.flatMap(session => session.texts).filter(text => text.at >= state.windowStart && text.customType === "agent_message" && text.fromId &&
    !family.has(text.fromId) && text.relation !== "child" && text.relation !== "parent");
  add("d", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(text => `at ${iso(text.at)}: "${clip(text.text, 120)}"`).join("; ")
    : "only the owner-style message, server notes, wakes and the chat's own jobs reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "d")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of ${sessions.length} sessions (${[...family].map(id => id.slice(0, 8)).join(", ")}) and the board file.`, "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const savedLogin: Scenario = {
  name: "saved-login",
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
