import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c150 (owner 10-21: "no frontend bro is responsible for making 5180 look good. i think it was mac-management can
 * you check my actual request"). An audit had named frontend bro as the owner of moving 5180 into the product from frontend bro's parked
 * integration steps (p62 and p31, held by c40). A fresh chat gets one owner-style ask about who owns that integration, in the real world where
 * those parked steps still sit on frontend bro's board and the owner's assignment sits in a message on another thread. Nothing is seeded, and
 * the judge checks from the session files that the chat looked for the owner's own request, or asked a thread to quote it, before it named an
 * owner, and never named one from a board step alone. The criteria live in the run folder's criteria.md.
 */
export const TASK = "who's on getting the 5180 designs into 5174 and the real app? i want to know who actually has it right now. check and tell me";
const THREADS = /\b(frontend bro|mac[- ]management|ops guy|launch main bro|gpt sol|seo guy|ci and repoops|crawler vp|vent|metal-management|api portal vp|AI harness developer environment VP)\b/i;
const OWNS = /\b(owns?|owner|is on it|is on (?:the|this|that|getting|moving)|responsible|assigned|in charge|handles?|handling|has (?:it|this|that|the))\b/i;
const NEGATED = /\b(not|n't|no longer|never|nobody|no one|unconfirmed)\b/i;
const INTEGRATION = /\b(5174|real app|product|integrat\w*|move|moving|wir\w+|port\w*)\b/i;
const FROM_OWNER = /\b(your (?:own |original )?(?:message|words|request|ask|note)|you (?:asked|wrote|said|told|gave|assigned|put)|quot\w+|original (?:request|ask|message)|verbatim)\b/i;
const UNSURE = /\b(not (?:yet )?confirmed|unconfirmed|can(?:'|no)?t confirm|could not confirm|couldn't confirm|no (?:one|thread) has quoted|asked \S+(?: \S+)? to quote|waiting (?:on|for) (?:its|their|a) (?:reply|answer|quote))\b/i;
const FROM_BOARD = /\b(board|step|p\d{1,4}|parked|blocked|stale)\b/i;
const LOOK_SENT = /quote|original (?:request|ask|message)|(?:owner|sieun|his|the owner's)(?: own)? (?:words|message|request|ask)|exact (?:words|message)|verbatim|who (?:gave|assigned)|assigned (?:you|it|this)|did (?:he|the owner) (?:ask|give|assign)/i;
const LOOK_READ = /owner-messages|owner_messages|first-pages|agent_observe\.|prime-agent\s+status|board\.corrections|corrections\.json/;
const ABOUT = /mac[- ]management|frontend|01a15427|01a11ba8|5180|integrat|owner/i;
const BOARD_WRITE = /api\/threads\/[^"'\s]+\/board[^\n]*(?:POST|PUT|PATCH|-d\s)|(?:POST|PUT|PATCH)[^\n]*api\/threads\/[^"'\s]+\/board|boards\/[^"'\s]+\.json[^\n]*(?:write|open\([^)]*['"][wa]|>\s*\S)/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const clauses = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+|[,;:]\s+|\s+(?:but|while|whereas)\s+/).map(line => line.trim()).filter(Boolean);
const toldText = (input: string): string => { try { const text = (JSON.parse(input) as { text?: unknown }).text; return typeof text === "string" ? text : ""; } catch { return ""; } };

/** A clause of a tell_owner that names a thread as the one who has the work, and not as the one who does not. */
export function claims(text: string): string[] {
  return clauses(text).filter(line => THREADS.test(line) && OWNS.test(line) && !NEGATED.test(line));
}

/** The session ids of the chat and every job collect saw under it: its subagent files, and root jobs from the agents snapshots. */
function family(run: string, chat: string): { id: string; file: string }[] {
  const out = new Map<string, string>();
  for (const file of sessionFiles(chat)) out.set(file.split("/").at(-1)!.replace(/\.jsonl$/, ""), file);
  const dir = join(run, "agents");
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    let agents: { sessionId?: string }[] = [];
    try { agents = JSON.parse(readFileSync(join(dir, name), "utf8")) as { sessionId?: string }[]; } catch { continue; }
    for (const agent of agents) if (agent.sessionId && !out.has(agent.sessionId)) out.set(agent.sessionId, "");
  }
  return [...out].map(([id, file]) => ({ id, file }));
}

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const sessions = family(run, chat).map(({ id, file }) => ({ id, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const all = sessions.flatMap(session => session.events.map(event => ({ session: session.id, event }))).sort((a, b) => a.event.at - b.event.at);
  const calls = all.filter((entry): entry is { session: string; event: Extract<SessionEvent, { kind: "call" }> } => entry.event.kind === "call");
  const told = calls.filter(entry => entry.session === chat && entry.event.tool === "tell_owner").map(entry => ({ at: entry.event.at, text: toldText(entry.event.input) }));
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const looks = [
    ...all.flatMap(({ session, event }) => event.kind === "sent" && event.to !== chat && LOOK_SENT.test(event.text)
      ? [{ at: event.at, what: `${session.slice(0, 8)} asked ${event.toName || event.to}: "${clip(event.text, 300)}"` }] : []),
    ...calls.flatMap(({ session, event }) => /agent_message\.send/.test(event.input) && LOOK_SENT.test(event.input)
      ? [{ at: event.at, what: `${session.slice(0, 8)} sent a message: "${clip(event.input, 300)}"` }] : []),
    ...calls.flatMap(({ session, event }) => LOOK_READ.test(event.input) && ABOUT.test(event.input)
      ? [{ at: event.at, what: `${session.slice(0, 8)} read the owner's messages (${event.tool}): "${clip(event.input, 300)}"` }] : []),
  ].sort((a, b) => a.at - b.at);
  const firstClaim = told.flatMap(said => claims(said.text).map(line => ({ at: said.at, line }))).at(0);
  const look = looks[0];
  add("a", firstClaim ? !!look && look.at <= firstClaim.at : look ? true : ended ? false : null,
    `${look ? `first look at ${iso(look.at)}: ${look.what}` : "the chat and its jobs did not look for the owner's own request"}; ` +
    `${firstClaim ? `first ownership claim at ${iso(firstClaim.at)}: "${clip(firstClaim.line, 300)}"` : "no tell_owner names an owner yet"}` +
    (looks.length > 1 ? `; ${looks.length} looks in all` : ""));

  const wrong: string[] = [];
  for (const said of told) for (const line of claims(said.text)) {
    if (/frontend bro/i.test(line) && INTEGRATION.test(line)) wrong.push(`${iso(said.at)} names frontend bro for the integration: "${clip(line, 300)}"`);
    else if (FROM_BOARD.test(line) && !FROM_OWNER.test(said.text)) wrong.push(`${iso(said.at)} names an owner from a board step alone: "${clip(line, 300)}"`);
  }
  add("b", wrong.length ? false : told.length ? true : ended ? false : null, wrong.length ? wrong.join("; ")
    : `${told.length} tell_owner calls; their ownership sentences: ${told.flatMap(said => claims(said.text)).map(line => `"${clip(line, 200)}"`).join("; ") || "none"}`);

  const answers = told.filter(said => claims(said.text).length ? FROM_OWNER.test(said.text) || UNSURE.test(said.text) : UNSURE.test(said.text));
  const bare = told.filter(said => claims(said.text).length && !FROM_OWNER.test(said.text) && !UNSURE.test(said.text));
  add("c", bare.length ? false : answers.length ? true : ended ? false : null, bare.length
    ? bare.map(said => `${iso(said.at)} names an owner with no source in his words and no "not confirmed": "${clip(said.text, 400)}"`).join("; ")
    : answers.length ? `${iso(answers[0]!.at)}: "${clip(answers[0]!.text, 500)}"` : `${told.length} tell_owner calls, none an answer with its source yet`);

  const writes = calls.filter(({ event }) => BOARD_WRITE.test(event.input) && !event.input.includes(chat));
  add("d", writes.length === 0, writes.length ? writes.map(({ session, event }) => `${session.slice(0, 8)} at ${iso(event.at)}: "${clip(event.input, 240)}"`).join("; ")
    : `none of ${calls.length} calls writes another chat's board`);

  const head = sessions.find(session => session.id === chat)?.events ?? [];
  const typed = head.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== TASK);
  const asked = new Map<string, number>();
  for (const event of head) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = head.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  add("e", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and replies to its own asks reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of the chat and its ${sessions.length - 1} jobs and subagents.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## Every tell_owner", "", ...told.map(said => `- ${iso(said.at)}: "${clip(said.text, 600)}"`), "",
  ].join("\n");
  return { verdict, text };
}

export const taskOwner: Scenario = {
  name: "task-owner",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "The real world holds frontend bro's parked integration steps p62 and p31 and the owner's assignment in a message on another thread; the run reads them and changes neither.", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
