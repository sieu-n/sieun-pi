import { hrefFor } from "$lib/router.svelte";
import type { ChatBoard } from "$lib/api";

/** The board page of one chat, focused on a step, an ask or a duty. */
export const boardHref = (chatId: string, focus?: string): string => hrefFor("board", [chatId], { focus });

/** One ask open in For you. */
export const forYouHref = (chatId?: string, todoId?: string): string =>
  hrefFor("board", chatId && todoId ? ["for-you", chatId, todoId] : ["for-you"]);

const short = (text: string): string => (text.length > 60 ? text.slice(0, 59).trimEnd() + "\u2026" : text);

/** Every id on a chat's board with a short title, for Markdown's board chips and the chip tooltips. */
export function boardTitles(board: ChatBoard | null | undefined, duties: readonly { id: string; name: string }[] = []): Map<string, string> {
  const titles = new Map<string, string>();
  const walk = (steps: ChatBoard["plan"]) => {
    for (const step of steps) {
      titles.set(step.id, short(step.text));
      walk(step.children);
    }
  };
  walk(board?.plan ?? []);
  for (const todo of board?.todos ?? []) titles.set(todo.id, short(todo.text));
  for (const duty of duties) titles.set(duty.id, short(duty.name));
  return titles;
}

const known = new Map<string, Map<string, string>>();

/** Keep a chat's titles so `chipTitle` answers for any page that loaded the board. */
export function rememberTitles(chatId: string, titles: Map<string, string>): void {
  known.set(chatId, titles);
}

/** "p12 · Deploy the chat to production", or the bare id when no open page has loaded that chat's board. */
export function chipTitle(chatId: string, id: string): string {
  const title = known.get(chatId)?.get(id);
  return title ? `${id} · ${title}` : id;
}
