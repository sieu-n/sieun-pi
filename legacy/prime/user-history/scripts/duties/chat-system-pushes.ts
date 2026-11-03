import { LIVE_GAP_MS, OPEN, walk } from "../../src/checkin-steps.ts";
import { listedSessions } from "../../src/daemon-faults.ts";
import { turnError } from "../../src/shared/credential-wait.ts";
import { heldByTodo } from "../../src/shared/todo-hold.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";

/**
 * How the Chat system duty (d9, chat-system.ts) reads the pushes its last run sent and the chats that cannot take a turn: the pushes file's
 * lines, whether each reached and was read in its chat's transcript, whether the chat settled what it named, and a chat whose every turn fails.
 * Moved out of chat-system.ts on 11-03 to keep that file under its 1,000-line limit; chat-system.ts re-exports each name.
 */

const ms = (iso: string | undefined): number => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : 0; };

/**
 * One push the duty job sent a chat (`PUSHES_FILE`): when, the tag it put in the message, and the items it named. `session` is the chat's root
 * job the push went to in place of the chat (`downRoutes`).
 */
export interface Push { at: number; chat: string; tag: string; items: string[]; session?: string; delivery?: string }
/**
 * How a push the last run's job sent went: whether its tag reached the chat's transcript, the chat answered after it, and a job started since.
 * `away` names the box the chat runs on when this box reads its transcript from a mirror copy and Tailscale reads that box offline: the push
 * sits in the queue until the box answers, so a second send only queues a duplicate. On 10-24 the 13:19Z run flagged both 11:25Z pushes to
 * frontend bro as never delivered and asked for them again while the Mac sat offline for 7 hours with its steps held on For you t30.
 */
export interface PushCheck { push: Push; delivered: boolean; read: boolean; jobStarted: boolean; away?: string; settled?: boolean }

/**
 * Whether every step a push named has closed on the chat's board since, or waits on an open For you todo (`heldByTodo`), and every duty it
 * named is no longer red (`redDuties`, the chat's red duty ids, less those red only on counts that age out): then the chat acted and owes no followup. On 10-24 the 23:10 run asked to steer ops guy again about p475, which the chat had dropped as a duplicate of p450,
 * whose job sleeps on a wake, and the 20:53Z run asked to steer ops guy again about p518, which waited only on the owner's t34.
 */
export function pushSettled(board: ChatBoard | null, items: readonly string[], redDuties: ReadonlySet<string> = new Set()): boolean {
  if (!items.length || !board) return false;
  const steps = new Map<string, PlanItem>();
  walk(board.plan, item => { steps.set(item.id, item); });
  return items.every(id => {
    // A duty the push named (d2, checkin) is settled once it reads green: on 10-28 the 10:50Z run asked to steer (temp) mcp again about
    // "p30, p38, checkin" after its check-in went green at 10:02Z and both steps were done or held on For you t11.
    if (/^(?:d\d+|checkin)$/.test(id)) return !redDuties.has(id);
    const step = steps.get(id);
    return step !== undefined && (!OPEN.has(step.status) || heldByTodo(step, board.todos));
  });
}

/**
 * The pushes in the pushes file recorded at or after `since`. A line whose delivery is "not sent" records a run's choice to send nothing, so it
 * is no push: on 11-01 the 21:49Z run held ops guy's d3 followup since the chat had answered, and the 23:49Z run read it as never delivered.
 */
export function pushesSince(text: string, since: number): Push[] {
  return text.split("\n").flatMap(line => {
    try { const push = JSON.parse(line) as Push; return push.at >= since && push.delivery !== "not sent" ? [push] : []; } catch { return []; }
  });
}

/**
 * The transcript a push went to. A push can go to a session that is no owner chat, like the release owner 01a10810 or the metal box owner
 * 01a11d24, so it is looked up in the catalog by its own id; on 10-20 the 15:57Z run read both 13:45Z pushes as never delivered, though
 * each sat in its transcript from 14:03Z.
 */
export function pushedFile(listed: ReadonlyMap<string, { file?: string }>, copies: readonly string[], chat: string): string | undefined {
  return listed.get(chat)?.file ?? listedSessions(copies, [chat]).get(chat)?.file;
}

/**
 * The tagged push in a chat's transcript lines: delivered when an agent message or a user message carries the tag, read when an assistant line
 * comes after it. The server sends d9's pushes itself since ce020858, and they land as user messages: the 07:02Z run on 10-23 read all 7 of
 * the 05:01Z pushes as not delivered, while the AI harness chat's transcript held its push as a user line from 05:01:46Z.
 */
export function pushReached(lines: readonly string[], tag: string): { delivered: boolean; read: boolean } {
  let delivered = false;
  for (const line of lines) {
    if (!delivered) { if ((line.includes('"agent_message"') || line.includes('"role":"user"')) && line.includes(tag)) delivered = true; continue; }
    if (line.includes('"role":"assistant"') && !line.includes('"stopReason":"error"')) return { delivered, read: true };
  }
  return { delivered, read: false };
}

/**
 * A chat that cannot take a turn: every model turn it took since `since` failed, and `cause` names why (`turnErrorCause`, with its pi-pool
 * selection when that is Manual). A push to it lands in its transcript and nobody reads it. From 10-24 to 10-26 d9 pushed frontend bro 6 times
 * on p330, p332 and p333 while every turn of it since 10-23 09:12Z ended on "Provider rate limit exceeded (rate_limit_error, 429) ...
 * pi-pool: Manual f6cee98e-... remains selected.", since `pi-pool use` had pinned it to claude8@slack.green, limited until 10-29 02:00Z.
 */
export interface ChatDown { chat: string; since: number; turns: number; cause: string }

/**
 * The failed model turns at the end of a transcript's lines: those after its last assistant message that did not fail, when the last one
 * failed and the first of them is LIVE_GAP_MS old or older, the longest quiet a working session shows between model calls, so a turn in
 * Prime's provider retry does not read as down.
 */
export function failingTurns(lines: readonly string[], now: number): { since: number; turns: number; error: string; provider?: string } | undefined {
  let failed: { since: number; turns: number; error: string; provider?: string } | undefined;
  for (const line of lines) {
    if (!line.includes('"role":"assistant"')) continue;
    let entry: { type?: string; timestamp?: string; message?: { role?: string; stopReason?: string; errorMessage?: unknown; diagnostics?: unknown; provider?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason !== "error") { failed = undefined; continue; }
    const provider = typeof entry.message.provider === "string" ? { provider: entry.message.provider } : {};
    failed = { since: failed?.since ?? ms(entry.timestamp), turns: (failed?.turns ?? 0) + 1, error: turnError(entry.message) ?? "error", ...provider };
  }
  return failed && now - failed.since >= LIVE_GAP_MS ? failed : undefined;
}

/** A Manual pi-pool selection from `pi-pool who --json --session <id>`, with its account and when its slot comes; undefined for Auto or a reply it cannot read. */
export function manualSelection(who: unknown, provider: string): string | undefined {
  const entry = (who as { providers?: Record<string, { selection?: { mode?: unknown; account_id?: unknown }; current?: { email?: unknown }; wait?: { slot_at?: unknown } | null }> })
    ?.providers?.[provider];
  if (entry?.selection?.mode !== "manual") return undefined;
  const account = typeof entry.current?.email === "string" ? entry.current.email : String(entry.selection.account_id ?? "an account");
  const slot = typeof entry.wait?.slot_at === "number" ? `, whose pi-pool slot comes at ${new Date(entry.wait.slot_at * 1000).toISOString().slice(0, 16)}Z` : "";
  return `Manual ${account}${slot}`;
}

/** The `chat_down` line of a chat that cannot take a turn, which the detail file's push list and the flagged slices open with. */
export const downLine = (down: ChatDown, name: string): string => `chat_down: ${name} has failed every turn since ` +
  `${new Date(down.since).toISOString().slice(0, 16)}Z (${down.cause}), ${down.turns} failed ${down.turns === 1 ? "turn" : "turns"}; d9 sent it no push this run. ` +
  "Ask the owner on For you to bring it back, or move its steps to a chat that runs, and push it nothing until it takes a turn";
