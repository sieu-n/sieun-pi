import type { JobFact } from "./checkin-steps.ts";
import { clockTime } from "./checkin-settings.ts";
import { noticeStands } from "./no-report.ts";
import { chatLines, JOB_NOTICE_PREFIX } from "./shared/chat-feed.ts";
import type { OwnerTodo, ThreadMessage } from "./shared/types.ts";

/** A demo variant switch, as a link or a report names it: `?v.creators=campaigns-final`. */
const VARIANT = /\bv\.([a-z][\w-]*)=([\w./-]*[\w-])/gi;

/**
 * The demo screens a text names, one `v.<app>=<variant>` per variant switch. A job's report and a message to the owner name the same screens
 * when they share one. A URL with no switch counts for nothing: on frontend bro's reports from 10-14 to 10-19, path matches ("/", "/health",
 * "/configure?scenario=...") left 15 debts open that no link to the owner matched, the onboarding form's among them, which he got at 09:00Z
 * on 10-19 with another query.
 */
export function screenKeys(text: string): Set<string> {
  return new Set([...text.matchAll(VARIANT)].map(([, app, variant]) => `v.${app!.toLowerCase()}=${variant}`));
}

/** A job that named its screens on 5180 (`keys`, from its first such report at `at` on) while nothing sent to the owner since names one of them. */
export interface OwedLink { job: string; at: number; keys: string[] }

/**
 * The 5180 links the chat owes the owner (c124, owner 10-19 08:57Z: "얼라인이 맞는지 보는 제일 쉬운 방법이 5180 frontend 보는거니까"). A job's
 * report that names its screens (`screenKeys`) opens a debt; a line the owner reads (`chatLines` agent lines: a tell_owner call the tool sent,
 * the chat's text on his turn) or a For you todo, text or links, that names one of the job's screens pays it, and a screen he already has a
 * link to opens none. Only jobs still in the chat's roster count, a cancelled one not. frontend bro 10-19: "campaigns final build"
 * reported "It renders with ?v.creators=campaigns-final" at 08:42Z, the chat told the owner at 08:57:15Z "I'll send the link as soon as its
 * screens render", the job said "Home is built (shots checked)" 17 s later, the [job] notices for its builders cf-home (09:05Z) and cf-funnel (09:13Z) went by, and the owner asked "wheres the
 * campaign app i requested?" at 09:17:30Z. The link to an onboarding screen sent at 09:00Z named other screens, so it paid nothing.
 */
export function owedLinks(messages: readonly ThreadMessage[], facts: readonly JobFact[], todos: readonly OwnerTodo[] = []): OwedLink[] {
  const roster = new Set(facts.filter(fact => !fact.cancelled).map(fact => fact.name));
  type Event = { at: number; keys: Set<string>; job?: string };
  const events: Event[] = [
    ...chatLines(messages).flatMap((line): Event[] => line.kind === "agent" ? [{ at: line.at, keys: screenKeys(line.text) }]
      : line.kind === "job" && roster.has(line.from) ? [{ at: line.at, keys: screenKeys(line.body), job: line.from }] : []),
    ...todos.map((todo): Event => ({ at: Date.parse(todo.at) || 0, keys: screenKeys([todo.text, ...(todo.links ?? []).map(link => link.target)].join(" ")) })),
  ].filter(event => event.keys.size > 0).sort((a, b) => a.at - b.at);
  const sent = new Set<string>();
  const owed = new Map<string, { at: number; keys: Set<string> }>();
  for (const event of events) {
    if (event.job === undefined) {
      for (const key of event.keys) sent.add(key);
      for (const [job, debt] of owed) if ([...debt.keys].some(key => event.keys.has(key))) owed.delete(job);
      continue;
    }
    // A screen the owner already has a link to opens no debt: a later report on the same variant is the same review.
    const fresh = [...event.keys].filter(key => !sent.has(key));
    if (!fresh.length) continue;
    const debt = owed.get(event.job);
    if (debt) for (const key of fresh) debt.keys.add(key);
    else owed.set(event.job, { at: event.at, keys: new Set(fresh) });
  }
  return [...owed].map(([job, debt]) => ({ job, at: debt.at, keys: [...debt.keys] }));
}

/** The server's line to the chat for one owed link: what the job named and when, and the tell_owner call that reaches the owner on a wake-up. */
export const owedLinkLine = ({ job, at, keys }: OwedLink): string =>
  `${JOB_NOTICE_PREFIX}${job} named its screens on 5180 at ${clockTime(at)} (${keys.join(", ")}), and no message to the owner or ` +
  "For you todo since carries that link. Open them now and look at one shot with attach_image (c118). If they render, send him the " +
  "localhost:5180 link and the shot with tell_owner now, why \"answer\" and reply_to his message that asked for this work (c124); if they do " +
  "not, send the job back";

/**
 * The owed-link lines the server steers into the chat at a check-in, one per job (`owedLinks`), left out while the chat already holds it with
 * no message from the job after it (`noticeStands`).
 */
export const owedLinkLines = (messages: readonly ThreadMessage[], facts: readonly JobFact[], todos: readonly OwnerTodo[] = []): string[] =>
  owedLinks(messages, facts, todos).flatMap(debt => { const line = owedLinkLine(debt); return noticeStands(messages, debt.job, line) ? [] : [line]; });
