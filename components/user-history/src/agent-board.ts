import { chatService } from "./chat-host.ts";
import { BoardStore } from "./chat-board-store.ts";
import type { OtherAsk } from "./chat-guard.ts";
import { jobNames } from "./limit-names.ts";
import { ownerChats } from "./owner-chats.ts";
import { BoardError, parseBoardOps } from "./shared/chat-board.ts";
import { laneHoldFlag } from "./shared/lane-hold.ts";
import { boardLimitFlag } from "./shared/reply-lint.ts";
import type { ChatBoard } from "./shared/types.ts";

export interface AgentBoardWrite { board: ChatBoard | null; summaries: string[]; others?: OtherAsk[] }

/**
 * An agent's chat_board ops: the board applies them with its flags, and a c43 limit claim or a c72 lane hold adds a flag line each. With
 * `others`, the answer also carries the open For you todos of the owner's other chats, which tell_owner's same-ask check reads.
 */
export async function applyAgentOps(dataDir: string, sessionId: string, raw: unknown, others = false): Promise<AgentBoardWrite> {
  const ops = parseBoardOps(raw);
  const flags = [boardLimitFlag(ops) && boardLimitFlag(ops, await jobNames(dataDir)), laneHoldFlag(ops)].filter(flag => flag !== null);
  const write = await new BoardStore(dataDir).apply(sessionId, ops, "agent");
  const flagged = flags.length ? { ...write, summaries: [...write.summaries, ...flags] } : write;
  return others ? { ...flagged, others: await otherAsks(dataDir, sessionId) } : flagged;
}

/** The open todos the owner's other chats (`ownerChats`) put on For you; a board that does not read adds none. */
export async function otherAsks(dataDir: string, sessionId: string): Promise<OtherAsk[]> {
  const store = new BoardStore(dataDir);
  const chats = (await ownerChats(dataDir)).filter(id => id !== sessionId);
  const boards = await Promise.all(chats.map(async chat => ({ chat, board: await store.read(chat).catch(() => null) })));
  return boards.flatMap(({ chat, board }) => (board?.todos ?? []).filter(todo => !todo.done && todo.from === "agent").map(todo => ({ chat, id: todo.id, text: todo.text, at: todo.at })));
}

/**
 * The chat_board write as the live chat service judges it (`POST api/threads/<id>/agent-board`). A session keeps the extension code it last
 * loaded, so its own copy of the gates can be older than the release: on 10-15 slack green guy's chat had loaded at 08:50Z, before c74 (81a0540,
 * 09:20Z), and at 10:18Z its p71 move to doing was refused with the c49 go gate while a fresh check-in session moved the same step. Through the
 * service, a gate or rule change reaches every session when the service restarts on the new release. Null when no service takes the write (no
 * instance record, connection refused, or a service from before this route); the caller then applies with its own copy.
 */
export async function agentOpsViaService(dataDir: string, sessionId: string, raw: unknown, signal?: AbortSignal, others = false): Promise<AgentBoardWrite | null> {
  const service = await chatService(dataDir);
  if (!service) return null;
  let response: Response;
  try {
    response = await fetch(`${service.base}api/threads/${encodeURIComponent(sessionId)}/agent-board`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Token": service.token, Origin: service.origin }, body: JSON.stringify({ ops: raw, ...(others ? { others } : {}) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // This box's own service may be down; then the session's copy applies the ops to this box's board. The chat host's boards are the only live
    // ones, so a remote failure throws instead.
    if (!service.remote && (error as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED") return null;
    throw error;
  }
  if (response.status === 404 && !service.remote) return null;
  const body = await response.json() as { board?: ChatBoard | null; summaries?: string[]; others?: OtherAsk[]; error?: string };
  if (!response.ok) throw new BoardError(response.status === 403 ? "forbidden" : response.status === 409 ? "unknown" : "invalid", body.error ?? `Chat service answered ${response.status}.`);
  return { board: body.board ?? null, summaries: body.summaries ?? [], ...(Array.isArray(body.others) ? { others: body.others } : {}) };
}
