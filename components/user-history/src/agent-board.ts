import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BoardStore } from "./chat-board-store.ts";
import { jobNames } from "./limit-names.ts";
import { BoardError, parseBoardOps } from "./shared/chat-board.ts";
import { boardLimitFlag } from "./shared/reply-lint.ts";
import type { ChatBoard } from "./shared/types.ts";

export interface AgentBoardWrite { board: ChatBoard | null; summaries: string[] }

/** An agent's chat_board ops: the board applies them with its flags, and a c43 limit claim adds one more flag line. */
export async function applyAgentOps(dataDir: string, sessionId: string, raw: unknown): Promise<AgentBoardWrite> {
  const ops = parseBoardOps(raw);
  const flag = boardLimitFlag(ops) && boardLimitFlag(ops, await jobNames(dataDir));
  const write = await new BoardStore(dataDir).apply(sessionId, ops, "agent");
  return flag ? { ...write, summaries: [...write.summaries, flag] } : write;
}

/**
 * The chat_board write as the live chat service judges it (`POST api/threads/<id>/agent-board`). A session keeps the extension code it last
 * loaded, so its own copy of the gates can be older than the release: on 10-15 slack green guy's chat had loaded at 08:50Z, before c74 (81a0540,
 * 09:20Z), and at 10:18Z its p71 move to doing was refused with the c49 go gate while a fresh check-in session moved the same step. Through the
 * service, a gate or rule change reaches every session when the service restarts on the new release. Null when no service takes the write (no
 * instance record, connection refused, or a service from before this route); the caller then applies with its own copy.
 */
export async function agentOpsViaService(dataDir: string, sessionId: string, raw: unknown, signal?: AbortSignal): Promise<AgentBoardWrite | null> {
  let url: string;
  let token: string;
  try {
    const instance = JSON.parse(await readFile(join(dataDir, "instance.json"), "utf8")) as { url?: unknown };
    const config = JSON.parse(await readFile(join(dataDir, "configuration.json"), "utf8")) as { csrfToken?: unknown };
    if (typeof instance.url !== "string" || typeof config.csrfToken !== "string") return null;
    url = instance.url;
    token = config.csrfToken;
  } catch { return null; }
  let response: Response;
  try {
    response = await fetch(`${url}api/threads/${encodeURIComponent(sessionId)}/agent-board`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Token": token, Origin: new URL(url).origin }, body: JSON.stringify({ ops: raw }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if ((error as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED") return null;
    throw error;
  }
  if (response.status === 404) return null;
  const body = await response.json() as { board?: ChatBoard | null; summaries?: string[]; error?: string };
  if (!response.ok) throw new BoardError(response.status === 403 ? "forbidden" : response.status === 409 ? "unknown" : "invalid", body.error ?? `Chat service answered ${response.status}.`);
  return { board: body.board ?? null, summaries: body.summaries ?? [] };
}
