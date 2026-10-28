import { openDaemon } from "../src/daemon-list.ts";

/**
 * `node --import tsx scripts/session-tools.ts <active session id> [--reload] [--wait-idle <min>]` prints the active tools of a resident session
 * (get_connection_state) and which user-history tools are missing from them, and with --reload reruns its extensions through the daemon's per-session `reload`,
 * the request the chat service sends a chat on a new build. The reload runs only while the daemon shows the session doing nothing, so no turn,
 * tool call or kernel bash is cut (c88). It never stops a worker or the daemon. Written on 10-28 after 04b5dc19 dropped the user-history
 * extension from every session that started or reloaded between 23:37Z and 00:30Z, and roots the chat service does not track as chats stayed
 * without chat_board after the fix.
 */
const TOOLS = ["chat_board", "tell_owner", "search_history"];
const [id, ...rest] = process.argv.slice(2);
if (!id) { process.stderr.write("usage: session-tools.ts <active session id> [--reload] [--wait-idle <min>]\n"); process.exit(2); }
const reload = rest.includes("--reload");
const waitAt = rest.indexOf("--wait-idle");
const waitMs = waitAt >= 0 ? Number(rest[waitAt + 1]) * 60_000 : 0;

const client = await openDaemon();
const ask = async (request: Record<string, unknown>) => client.request({ ...request, activeSessionId: id } as never, 60_000, { recoverable: false });
// The tools the session's next model request carries: Prime builds the request's tool list from activeToolNames (checked on 10-28 by
// capturing an openai-codex request from a chat-mode session: ipython, search_history, chat_board, tell_owner, correction_add).
const tools = async () => {
  const state = await ask({ type: "get_connection_state" });
  if (!state.success) throw new Error(state.error);
  const active = (state.data as { activeToolNames?: string[] }).activeToolNames ?? [];
  return { active, missing: TOOLS.filter(name => !active.includes(name)) };
};
const busy = async () => {
  const state = await ask({ type: "get_state" });
  if (!state.success) throw new Error(state.error);
  const now = state.data as { isSessionActive?: boolean; isStreaming?: boolean; isCompacting?: boolean; isBashRunning?: boolean };
  return now.isSessionActive !== false || now.isStreaming === true || now.isCompacting === true || now.isBashRunning === true;
};
try {
  const before = await tools();
  const out: Record<string, unknown> = { id, before };
  if (reload) {
    const until = Date.now() + waitMs;
    while (await busy() && Date.now() < until) await new Promise(done => setTimeout(done, 2_000));
    if (await busy()) out.reload = "skipped: the session is busy";
    else {
      const answer = await ask({ type: "reload" });
      out.reload = answer.success ? "reloaded" : `failed: ${answer.error}`;
      out.after = await tools();
    }
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} finally { client.close(); }
