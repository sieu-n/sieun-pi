import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The daemon commands that only read: the session lists, the roster stream, the heartbeat lists and a session's state and transcript. Not
 * `attach`: an attach made the 10-18 12:17Z scratch serve run its build-change reload on the live chat 01a14d31. Not
 * `get_direct_worker_transport`, which issues a worker grant.
 */
export const DAEMON_READS: ReadonlySet<string> = new Set(["list", "list_saved_sessions", "roster_subscribe", "roster_unsubscribe", "cron_list", "heartbeats_list",
  "heartbeat_get", "get_state", "get_connection_state", "get_messages", "get_session_context", "get_queue", "get_session_header", "get_session_stats",
  "get_rlm_children", "get_context_tree", "get_session_tree", "get_commands", "get_available_models", "get_model_catalog", "get_system_prompt",
  "get_last_assistant_text", "get_rlm_max_depth_status", "get_resource_snapshot"]);

/**
 * A socket in front of the daemon that a scratch serve uses as its only daemon socket. It passes `DAEMON_READS` through and answers every
 * other command itself with a failure, so no path in the serve (a thread view, a build-change reload, a wake, an outbox send) can change a
 * session. The daemon's own lines (hello, responses, events) pass back unchanged.
 * `replay` (`serve --scratch --replay-daemon`): a connection whose daemon hello carries `replay: true`, which only a recorded fake daemon sends,
 * passes every command, so a profile can attach the chats a live start attaches. Any other daemon stays read-only.
 */
export async function readOnlyDaemon(upstream: string, log: (line: string) => void, options: { replay?: boolean } = {}): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "sieun-pi-scratch-"));
  const socketPath = join(dir, "daemon.sock");
  const refused = new Set<string>();
  const clients = new Set<Socket>();
  const server = createServer(client => {
    clients.add(client);
    const daemon = createConnection(upstream);
    const end = () => { client.destroy(); daemon.destroy(); clients.delete(client); };
    daemon.on("error", end).on("close", end);
    client.on("error", end).on("close", end);
    let replaying = false;
    if (options.replay) {
      let head = "";
      const hello = (chunk: Buffer) => {
        head += chunk;
        const newline = head.indexOf("\n");
        if (newline < 0) return;
        daemon.off("data", hello);
        try {
          const first = JSON.parse(head.slice(0, newline)) as { type?: unknown; replay?: unknown };
          replaying = first.type === "daemon_hello" && first.replay === true;
        } catch { replaying = false; }
        if (!replaying && !refused.has("replay")) { refused.add("replay"); log("scratch serve: the daemon hello has no replay mark, so this serve only reads"); }
      };
      daemon.on("data", hello);
    }
    daemon.pipe(client);
    let buffer = "";
    client.on("data", chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let wire: { type?: unknown; id?: unknown; command?: { type?: unknown } };
        try { wire = JSON.parse(line); } catch { continue; }
        const type = String((wire.type === "command" ? wire.command?.type : wire.type) ?? "");
        if (replaying || DAEMON_READS.has(type)) { daemon.write(line + "\n"); continue; }
        // A result acknowledgement only follows a command that changes a session, and none reached the daemon.
        if (type === "ack_result") continue;
        if (!refused.has(type)) { refused.add(type); log(`scratch serve: refused daemon command ${type}; a scratch serve only reads`); }
        client.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: false, error: `A scratch serve only reads: it does not send ${type} to the daemon.` }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
  return {
    socketPath,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
