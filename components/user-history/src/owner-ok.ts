import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { approvedTodo } from "./shared/chat-board.ts";
import type { OwnerTodo } from "./shared/types.ts";

/**
 * The owner's ok for one outside send (an email or a vendor ticket reply, c37): `<chat id>/<todo id>` names a For you todo on that chat's
 * board that is checked off and answered by the owner with its first choice or another go. The send guards (global-rules, aside-browser) ask this.
 */
export type OwnerOk = { ok: true; todo: OwnerTodo } | { ok: false; reason: string };

export const chatDataDir = (): string => process.env.AGENT_CHAT_DATA_DIR || join(homedir(), ".prime", "agent", "browser-chat");

export function ownerOk(token: string, dataDir: string = chatDataDir()): OwnerOk {
  const parts = token.trim().match(/^([\w-]+)\/([\w-]+)$/);
  if (!parts) return { ok: false, reason: `"${token}" is not <chat id>/<todo id>.` };
  const [, chat, id] = parts;
  let todos: OwnerTodo[];
  try {
    todos = (JSON.parse(readFileSync(join(dataDir, "boards", `${chat}.json`), "utf8")) as { todos?: OwnerTodo[] }).todos ?? [];
  } catch {
    return { ok: false, reason: `Chat ${chat} has no readable board in ${join(dataDir, "boards")}.` };
  }
  const todo = todos.find(entry => entry.id === id);
  if (!todo) return { ok: false, reason: `Chat ${chat} has no todo ${id}.` };
  if (todo.answeredBy !== "owner" || !todo.reply?.trim()) return { ok: false, reason: `The owner has not answered todo ${id} yet.` };
  if (!todo.done) return { ok: false, reason: `Todo ${id} is not checked off.` };
  if (!approvedTodo(todo)) return { ok: false, reason: `The owner's answer on todo ${id} ("${todo.reply}") is not a go.` };
  return { ok: true, todo };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const result = ownerOk(process.argv[2] ?? "");
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
