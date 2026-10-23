import { coversStep } from "./chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "./types.ts";

/**
 * For you holds: an open agent todo that holds a plan step by an explicit link, on this chat's board or on another chat's board that a wait
 * names. The check-in's end state, its goal holds, d9's stuck steps and the duty runs' fix steps all read it. Pure and browser-safe.
 */

/** A wait's link to another chat's todo: the chat's session id and then the todo id, like "thread:01a16213-54c6-73fa-b399-20e2713c41ba t11". */
export const LINKED_TODO = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(t\d+)\b/g;
/** A todo as `holdingTodo` reads it: one of this chat's, or another chat's that a wait here links (`chat`, its session id). */
export type HoldingTodo = Pick<OwnerTodo, "id" | "text" | "step" | "reply" | "done" | "from"> & { chat?: string };

/**
 * The open agent todo that holds the step by an explicit link, if any: it names the step's id, links it (`step`) or a PR it names (`coversStep`),
 * or the step's wait names the todo's id. A shared word is not a link: on 10-14 13 of the 17 steps the classes counted as For you matched only by
 * a word, and four of them waited on a release. A todo that only quotes a step's name is no link either, since a guessed hold can hide a step that
 * is really stuck (c88; tried in a4672f1 for Duties review's p14 and taken back).
 * Another chat's todo (`chat`, from `withLinkedTodos`) holds only a wait that names that chat's session id and the todo id (`LINKED_TODO`), and a
 * bare todo id names only this chat's todo: AI harness p919 waited for "thread:01a16213-54c6-73fa-b399-20e2713c41ba t11", Railway Breach's
 * open ask, while the chat's own t11 was an old closed todo.
 */
export function holdingTodo<T extends HoldingTodo>(item: Pick<PlanItem, "id" | "text" | "waitFor" | "note">, todos: readonly T[]): T | undefined {
  const id = new RegExp(`\\b${item.id}\\b`);
  const wait = item.waitFor ?? "";
  const linked = new Set([...wait.matchAll(LINKED_TODO)].map(([, chat, todo]) => `${chat} ${todo}`));
  const own = { ...item, text: item.text.replace(LINKED_TODO, ""), note: item.note?.replace(LINKED_TODO, ""), waitFor: wait.replace(LINKED_TODO, "") } as PlanItem;
  const named = new Set(own.waitFor!.match(/\bt\d+\b/g) ?? []);
  return todos.find(todo => todo.from === "agent" && !todo.done && (todo.chat !== undefined ? linked.has(`${todo.chat} ${todo.id}`)
    : id.test(todo.text) || coversStep(todo, own) || named.has(todo.id)));
}
export const heldByTodo = (item: Pick<PlanItem, "id" | "text" | "waitFor" | "note">, todos: readonly HoldingTodo[]): boolean => holdingTodo(item, todos) !== undefined;
/** A holding todo as a line names it: "t11" for this chat's, "t11 on thread 01a16213-54c6-73fa-b399-20e2713c41ba" for another chat's. */
export const todoName = (todo: Pick<HoldingTodo, "id" | "chat">): string => todo.chat ? `${todo.id} on thread ${todo.chat}` : todo.id;

/**
 * The For you todos of other chats that this board's waits name: a wait with a chat's session id and then a todo id, like "chat-057a's For you
 * (01a14210-4e7d-72c3-aa67-e3d476f4e728 t6)". mac-management 10-19: p5 "Token usage reaches LGTM" waited on chat-057a's t6, the owner's choice on
 * a one-time update window, and goal_gaps flagged it in every check-in, because `ownerHeld` read only the chat's own todos.
 */
export function linkedTodoRefs(plan: readonly PlanItem[]): { chat: string; id: string }[] {
  const refs = new Map<string, { chat: string; id: string }>();
  const visit = (items: readonly PlanItem[]): void => {
    for (const item of items) {
      for (const match of (item.waitFor ?? "").matchAll(LINKED_TODO)) refs.set(`${match[1]} ${match[2]}`, { chat: match[1]!, id: match[2]! });
      visit(item.children);
    }
  };
  visit(plan);
  return [...refs.values()];
}

/**
 * The board with the open agent todos of other chats that its waits name (`linkedTodoRefs`), so a wait on one holds its goal like a todo of
 * its own. Each one keeps only its id and its chat (`HoldingTodo`): its text and step name the other chat's plan items, and its id another
 * chat's numbering, which would hold this chat's items and waits of the same id.
 */
export function withLinkedTodos(board: ChatBoard, linked: readonly { chat: string; todo: OwnerTodo }[]): ChatBoard {
  const open = linked.filter(({ todo }) => todo.from === "agent" && !todo.done)
    .map(({ chat, todo }): OwnerTodo & HoldingTodo => ({ id: todo.id, text: `For you ${todo.id} of chat ${chat}`, done: false, from: "agent", at: todo.at, chat }));
  return open.length ? { ...board, todos: [...board.todos, ...open] } : board;
}

/** The board with the open todos of the other chats its waits name (`linkedTodoRefs`), from the boards in `others`. */
export function withLinkedBoards(board: ChatBoard, self: string, others: ReadonlyMap<string, ChatBoard | null | undefined>): ChatBoard {
  return withLinkedTodos(board, linkedTodoRefs(board.plan).flatMap(ref => {
    const todo = ref.chat === self ? undefined : others.get(ref.chat)?.todos.find(entry => entry.id === ref.id);
    return todo ? [{ chat: ref.chat, todo }] : [];
  }));
}
/** `withLinkedBoards`, with each other chat's board read by `read`; a board that cannot be read gives no todo. */
export async function withBoardLinks(board: ChatBoard, self: string, read: (chat: string) => Promise<ChatBoard | null | undefined>): Promise<ChatBoard> {
  const chats = [...new Set(linkedTodoRefs(board.plan).map(ref => ref.chat))].filter(chat => chat !== self);
  return withLinkedBoards(board, self, new Map(await Promise.all(chats.map(async chat => [chat, await read(chat).catch(() => null)] as const))));
}

const OPEN: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);
/**
 * The fix steps and their holding todos when an open For you todo holds an open fix step (`duty` "<dutyId>/<metricKey>") of every one of
 * `keys` (`holdingTodo`, an explicit link only, c88), like "p919 on t11 on thread 01a16213-54c6-73fa-b399-20e2713c41ba"; otherwise undefined.
 * Give it the board with its linked todos (`withLinkedBoards`). Such a red duty waits on the owner: d9 counts it in no stuck_duties and no
 * fix_not_moving. On 10-23 d9 pushed the AI harness chat to replace p919's fix 5 runs in a row, while p919 waited only on the owner's Apple
 * sign-in, Railway Breach's open t11.
 */
export function dutyHold(duty: string, keys: readonly string[], board: ChatBoard | null | undefined): string | undefined {
  if (!board || !keys.length) return undefined;
  const holds = keys.map(key => {
    let found: string | undefined;
    const visit = (items: readonly PlanItem[]): void => {
      for (const item of items) {
        const todo = !found && item.duty === `${duty}/${key}` && OPEN.has(item.status) ? holdingTodo(item, board.todos) : undefined;
        if (todo) found = `${item.id} on ${todoName(todo)}`;
        visit(item.children);
      }
    };
    visit(board.plan);
    return found;
  });
  return holds.every(Boolean) ? [...new Set(holds)].join(", ") : undefined;
}
