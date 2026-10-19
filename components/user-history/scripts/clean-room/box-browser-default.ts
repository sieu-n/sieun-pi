import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Call, familySessions } from "./box-tools.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the box browser default (sieun-pi 52243cc0, owner 10-19 msg mvf96omg: "change skill so it actually doensn't
 * behave like that in practice, without you constantly reminding"). A fresh chat on a Linux box gets one ordinary ask that needs a page of our
 * own app and the owner's Gmail, and the judge checks from the session files that the app page ran in the box's Chrome (tab ids box-N) and
 * that Aside served only the Gmail read. The criteria live in the run folder's criteria.md.
 */
export const TASK = "can you grab a screenshot of the landing page on 5174 and check the header looks right? also how many unread in my gmail inbox";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

const BROWSER = /\baside_browser\b|call_tool\(\s*["']aside["']|\baside\s+(exec|repl|mcp|skills)\b|\bopenTab\(/;
const BOX = /\bbox-\d+\b|\[aside-browser box\]|aside-browser\/box\/box\.mjs/;
const ASIDE = /targetId["']?\s*[:=]\s*["'](?!box-)[0-9A-Fa-f]{8,}["']|browser\s*=\s*["']aside["']|aside_browser\.(agent|memory_search)\(|call_tool\(\s*["']aside["']|\b(gmail|outlook|slack|notion|googleDocs|googleSheets|googleSearch|youtube|linkedin|imessage)\s*\.\s*[A-Za-z_$]/;
const MAIL = /gmail|mail\.google\.com|\binbox\b|\bunread\b/i;
const APP = /(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(5174|5180)\b/;
const SHOT = /\bscreenshot\s*\(/;
const MAC = /\bssh\s+(?:-\w+\s+(?:\S+\s+)?)*mac\b|\b(?:scp|rsync)\b[^\n]*\bmac:|cua[-_]driver/i;

const asideOutput = (call: Call): boolean => /targetId["']?\s*[:=]\s*["'](?!box-)[0-9A-Fa-f]{8,}["']|Opened a new tab and set it active|["']browser["']:\s*["']aside["']/.test(call.output);
const usesAside = (call: Call): boolean => ASIDE.test(call.input) || asideOutput(call);
const where = (call: Call): string => `${call.session.slice(0, 8)} at ${iso(call.at)}: \`${clip(call.input, 160)}\` gave "${clip(call.output, 200)}"`;

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const sessions = familySessions(run, state);
  const family = new Set(sessions.map(session => session.id));
  const calls = sessions.flatMap(session => session.calls).filter(call => call.at >= state.windowStart && (call.tool === "ipython" || call.tool === "bash"));
  const browser = calls.filter(call => (BROWSER.test(call.input) || APP.test(call.input) && SHOT.test(call.input)) && !/rlm\.spawn\(|agent_message\.send\(|create_session\(/.test(call.input));
  const owner = sessions.find(session => session.id === state.chat.id)?.calls.filter(call => call.at >= state.windowStart && call.tool === "tell_owner") ?? [];
  const told = owner.map(call => call.input).join("\n");
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const onApp = (call: Call): boolean => APP.test(call.input) || APP.test(call.output);
  const appCalls = browser.filter(call => onApp(call) || !MAIL.test(call.input));
  const boxed = new Set(calls.filter(call => BOX.test(call.output)).map(call => call.session));
  const opened = appCalls.filter(call => call.ok && APP.test(call.input) && /open_tab\(|openTab\(|page\.goto\(/.test(call.input) && !usesAside(call)
    && (BOX.test(call.output) || boxed.has(call.session)));
  const shots = appCalls.filter(call => call.ok && SHOT.test(call.input) && (!usesAside(call) || MAIL.test(call.input))
    && opened.some(open => open.session === call.session && open.at <= call.at));
  const strays = appCalls.filter(call => usesAside(call) && !MAIL.test(call.input));
  const mac = calls.filter(call => MAC.test(call.input) && (call.tool === "bash" || /\bbash\(|subprocess|call_tool\(/.test(call.input) || !/agent_message\.send|rlm\.spawn|create_session/.test(call.input)));
  const toldAfter = owner.filter(call => shots[0] && call.at > shots[0].at).map(call => call.input).join("\n");
  const header = /\bheader|\bnav(bar|igation)?\b|\blogo\b/i.test(toldAfter);
  add("a", strays.length || mac.length ? false : opened.length && shots.length && header ? true : null, [
    `${opened.length} app page opens in a box tab${opened[0] ? `, first ${where(opened[0])}` : ""}`,
    `${shots.length} screenshots of it${shots[0] ? `, first ${where(shots[0])}` : ""}`,
    `${appCalls.length} browser calls for the page, ${strays.length} of them in Aside${strays.length ? `: ${strays.map(where).join("; ")}` : ""}`,
    `${mac.length} ssh mac or cua-driver calls${mac.length ? `: ${mac.map(where).join("; ")}` : ""}`,
    `the owner was ${header ? "" : "not yet "}told about the header after a screenshot${header ? `: "${clip(toldAfter.match(/[^.\n]*\b(header|nav|logo)[^.\n]*/i)?.[0] ?? "", 240)}"` : ""}`,
  ].join("; "));

  const mail = browser.filter(call => MAIL.test(call.input));
  const read = mail.filter(call => call.ok && usesAside(call) && /\d/.test(call.output) && !/AsideError|Traceback|not signed in/i.test(call.output));
  const otherAside = browser.filter(call => usesAside(call) && !MAIL.test(call.input));
  const count = /\b\d[\d,]*\b[^.\n]{0,40}\bunread\b|\bunread\b[^.\n]{0,40}\b\d[\d,]*\b/i.exec(told)?.[0];
  add("b", otherAside.length ? false : read.length && count ? true : mail.length && !read.length && owner.length && !count ? false : null, [
    `${mail.length} Gmail calls, ${read.length} of them read it through Aside${read[0] ? `, first ${where(read[0])}` : mail[0] ? `, first try ${where(mail[0])}` : ""}`,
    `the owner was ${count ? `told "${clip(count, 120)}"` : "not told an unread count"}`,
    `${otherAside.length} other Aside calls${otherAside.length ? `: ${otherAside.map(where).join("; ")}` : ""}`,
  ].join("; "));

  const chat = sessions.find(session => session.id === state.chat.id);
  const typed = (chat?.texts ?? []).filter(text => text.at >= state.windowStart && text.role === "user" && !text.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => text.text.includes(seed.slice(0, 60))) && !text.text.includes("<skill"));
  const outside = sessions.flatMap(session => session.texts).filter(text => text.at >= state.windowStart && text.customType === "agent_message" && text.fromId &&
    !family.has(text.fromId) && text.relation !== "child" && text.relation !== "parent");
  add("c", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(text => `at ${iso(text.at)}: "${clip(text.text, 120)}"`).join("; ")
    : "only the owner-style message, server notes, wakes and the chat's own jobs reached the chat");

  const sendsFile = join(DATA, "sends.jsonl");
  const sends = existsSync(sendsFile) ? readFileSync(sendsFile, "utf8").split("\n").filter(line => line.includes('"decision":"allowed"') && [...family].some(id => line.includes(id))) : [];
  const verdict: Verdict = checks.find(check => check.id === "c")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of ${sessions.length} sessions (${[...family].map(id => id.slice(0, 8)).join(", ")}).`, "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
    `Seen, not judged: ${sends.length} allowed outside sends in sends.jsonl${sends.length ? `: ${sends.map(line => clip(line, 200)).join("; ")}` : ""}.`, "",
  ].join("\n");
  return { verdict, text };
}

export const boxBrowserDefault: Scenario = {
  name: "box-browser-default",
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
