import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ChatService, remoteChatService, serviceCall } from "./chat-host.ts";
import { approvedTodo } from "./shared/chat-board.ts";
import type { OwnerTodo } from "./shared/types.ts";

/**
 * The owner's ok for one outside send (an email or a vendor ticket reply, c37): `<chat id>/<todo id>` names a For you todo on that chat's
 * board that is checked off and answered by the owner with its first choice or another go. The send guards (global-rules, aside-browser) ask this.
 *
 * The board is the live one: the chat service's on the chat host of hosts.json when that is another box, as the board skill reads it. The
 * local file is read only on the chat host, or when the chat host cannot be reached. On 10-18 the Mac's copy had stopped at 08:01Z since the
 * chat moved to us-metal02, so a Mac job's OWNER_OK for slack green guy's t26 ("Go: fix the links", 08:44Z) was refused with "no todo t26".
 * `source` says which board answered.
 */
export type OwnerOk = { ok: true; todo: OwnerTodo; source: string } | { ok: false; reason: string; source?: string };

export const chatDataDir = (): string => process.env.AGENT_CHAT_DATA_DIR || join(homedir(), ".prime", "agent", "browser-chat");

/**
 * How long the chat host may take to answer before the local file answers instead. The send guard runs this script with a 15 s limit
 * (send-guard.ts ownerOkTodo), so the read gives up before that and the fallback still runs.
 */
const SERVICE_WAIT_MS = 10_000;

type Todos = { todos: OwnerTodo[]; source: string } | { reason: string; source?: string };

async function liveTodos(chat: string, dataDir: string, remote: () => Promise<ChatService | null>): Promise<Todos> {
  let fallback = "";
  try {
    const service = await remote();
    if (service) {
      const board = await serviceCall<{ todos?: OwnerTodo[] }>(service, `api/agent/board?chat=${encodeURIComponent(chat)}`, undefined, AbortSignal.timeout(SERVICE_WAIT_MS));
      const source = `the chat host ${service.origin}`;
      return board ? { todos: board.todos ?? [], source } : { reason: `Chat ${chat} has no board on ${source}.`, source };
    }
  } catch (error) {
    fallback = `, because the chat host could not be reached (${error instanceof Error ? error.message : String(error)})`;
  }
  const file = join(dataDir, "boards", `${chat}.json`);
  const source = `the local file ${file}${fallback}`;
  try {
    return { todos: (JSON.parse(readFileSync(file, "utf8")) as { todos?: OwnerTodo[] }).todos ?? [], source };
  } catch {
    return { reason: `Chat ${chat} has no readable board in ${join(dataDir, "boards")}${fallback}.`, source };
  }
}

export async function ownerOk(token: string, dataDir: string = chatDataDir(), remote: () => Promise<ChatService | null> = () => remoteChatService()): Promise<OwnerOk> {
  const parts = token.trim().match(/^([\w-]+)\/([\w-]+)$/);
  if (!parts) return { ok: false, reason: `"${token}" is not <chat id>/<todo id>.` };
  const [, chat, id] = parts;
  const read = await liveTodos(chat!, dataDir, remote);
  if ("reason" in read) return { ok: false, ...read };
  const { todos, source } = read;
  const refuse = (reason: string): OwnerOk => ({ ok: false, reason: `${reason} (read from ${source})`, source });
  const todo = todos.find(entry => entry.id === id);
  if (!todo) return refuse(`Chat ${chat} has no todo ${id}.`);
  if (todo.answeredBy !== "owner" || !todo.reply?.trim()) return refuse(`The owner has not answered todo ${id} yet.`);
  if (!todo.done) return refuse(`Todo ${id} is not checked off.`);
  if (!approvedTodo(todo)) return refuse(`The owner's answer on todo ${id} ("${todo.reply}") is not a go.`);
  return { ok: true, todo, source };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const result = await ownerOk(process.argv[2] ?? "");
  if (result.source) process.stderr.write(`owner-ok: read ${process.argv[2]} from ${result.source}\n`);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
