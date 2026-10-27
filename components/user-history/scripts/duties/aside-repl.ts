import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The owner's Aside browser as a REPL that keeps its scope between calls, for the duties that time pages from the Mac (d1's offline walk,
 * demo-sandbox-walk.ts, and d2's chat page probe, chat-page-mac-probe.ts). Owner c177, 10-27: "can you remove Headless browser???? NEVER put
 * it back in. we'll always use Aside only."
 */

/** Each REPL call ends at 120 s in Aside (`aside guide repl`); a call with no answer by this time counts as failed, so a hung Aside cannot hang a run. */
const CALL_TIMEOUT_MS = 150_000;

export interface Repl { call: <T>(title: string, body: string) => Promise<T>; stop: () => void }

/**
 * One `aside mcp` process over stdio, so the REPL scope lives for the whole run. `call` runs `body` (the inside of an async function, which
 * returns a JSON value) and resolves that value; a REPL error or no answer within CALL_TIMEOUT_MS rejects. `command` and `args` start the
 * server: the CLI with `mcp` on the Mac, or `ssh <mac> <cli> mcp` from a box.
 */
export function asideRepl(command: string, args: readonly string[] = ["mcp"]): Repl {
  const child: ChildProcess = spawn(command, [...args], { stdio: ["pipe", "pipe", "ignore"], detached: true });
  let buffer = "", nextId = 0, exited: string | null = null;
  const waiting = new Map<number, (message: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }) => void>();
  child.on("error", error => { exited = error.message; for (const answer of waiting.values()) answer({ error: { message: exited } }); waiting.clear(); });
  child.on("exit", code => { exited = `aside mcp exited with code ${code}`; for (const answer of waiting.values()) answer({ error: { message: exited } }); waiting.clear(); });
  child.stdin!.on("error", () => { /* the exit handler reports it */ });
  child.stdout!.on("data", chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      let message: { id?: number };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id === "number") { waiting.get(message.id)?.(message as never); waiting.delete(message.id); }
    }
  });
  const send = (method: string, params: unknown) => new Promise<{ result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }>(answer => {
    if (exited) return answer({ error: { message: exited } });
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); answer({ error: { message: `no answer from aside mcp within ${CALL_TIMEOUT_MS} ms` } }); }, CALL_TIMEOUT_MS);
    waiting.set(id, message => { clearTimeout(timer); answer(message); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const ready = (async () => {
    const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sieun-pi-duty", version: "1" } });
    if (init.error) throw new Error(`aside mcp initialize: ${init.error.message}`);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();
  return {
    async call<T>(title: string, body: string): Promise<T> {
      await ready;
      const code = `{ const __walkValue = await (async () => { ${body} })(); console.log("WALK_RESULT " + JSON.stringify(__walkValue ?? null)); }`;
      const answer = await send("tools/call", { name: "repl", arguments: { title, code } });
      if (answer.error) throw new Error(answer.error.message ?? "aside mcp error");
      const text = (answer.result?.content ?? []).map(item => item.text ?? "").join("\n");
      if (answer.result?.isError) throw new Error(text.split("\n").find(line => line.trim()) ?? "REPL error");
      const line = text.split("\n").reverse().find(entry => entry.startsWith("WALK_RESULT "));
      if (!line) throw new Error(`no result in the REPL output: ${text.slice(0, 300)}`);
      return JSON.parse(line.slice("WALK_RESULT ".length)) as T;
    },
    stop() { child.stdin!.end(); setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 2000).unref(); },
  };
}

/** The Aside CLI: ASIDE_CLI, else ~/.local/bin/aside, where the Mac has it; a plain `ssh mac` PATH lacks ~/.local/bin. */
export const asideCli = () => process.env.ASIDE_CLI || join(homedir(), ".local/bin/aside");
