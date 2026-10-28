import { coversStep, firstClause } from "./chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "./types.ts";

/**
 * For you holds: an open agent todo that holds a plan step by an explicit link, on this chat's board or on another chat's board that a wait
 * names. The check-in's end state, its goal holds, d9's stuck steps and the duty runs' fix steps all read it. Pure and browser-safe.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IDS = "[pt]\\d+(?:\\s*(?:,|and|or)\\s*[pt]\\d+)*";
const BOARD_WORDS = "(?:(?:own|board|plan|steps?|for\\s+you|todos?)\\s+)*";
/** "01a16213-54c6-73fa-b399-20e2713c41ba t11", "thread:01a16213-... t11", "01a16213-...'s For you t11". */
const CHAT_THEN_IDS = new RegExp(`\\b(${UUID})(?:['’]s)?\\s+${BOARD_WORDS}(${IDS})\\b`, "gi");
/** "t17 in chat 01a16213-...", "t11 on thread 01a16213-..." (`todoName`). */
const IDS_THEN_CHAT = new RegExp(`\\b(${IDS})\\s+(?:in|on|of|from|at)\\s+(?:the\\s+)?(?:(?:chat|thread|board)\\s+)?(?:thread:)?(${UUID})\\b`, "gi");
/** "VP of CI's p134", "the API portal's own p8", "its t17", "their p3"; "this chat's" and "the owner's" name this board. */
const POSSESSIVE_IDS = new RegExp(`(?<!\\b(?:this(?:\\s+(?:board|chat|thread))?|owner))(?:['’]s|\\bits|\\btheir)\\s+${BOARD_WORDS}(${IDS})\\b`, "gi");

/**
 * A plan step or todo id that a wait names on another chat's board: `chat` is that chat's session id, or null when the wait ties the id to
 * another chat it does not name by one session ("its t17", or a name no chat or more than one chat carries).
 */
export interface WaitRef { id: string; chat: string | null }
/** A chat a wait can name by its name: a catalog row. Its short name is the part before " (", like "ops guy" for "ops guy (+observability)". */
export type NamedChat = { id: string; name: string; archived?: boolean };

/**
 * The ids a wait ties to another chat's board, and the rest of the wait with them cut out, where every id left names this chat's board. The
 * forms are "<session id> t17", "t17 in chat <session id>", "<chat name>'s t17" (resolved by `chats`), and "its t17" or "their t17". Every
 * check that reads a wait's ids uses it, so a check-in and d9 read a wait the same way. CI and RepoOps p420 waited for "the owner's answer on t17
 * in chat 01a16213-54c6-73fa-b399-20e2713c41ba (TypeSafe credits)", and two check-ins read the chat's own done t17 as the answer.
 */
export function waitRefs(text: string, chats: readonly NamedChat[] = []): { refs: WaitRef[]; rest: string } {
  const refs: WaitRef[] = [];
  const add = (ids: string, chat: string | null): void => { for (const id of ids.match(/[pt]\d+/gi) ?? []) refs.push({ id: id.toLowerCase(), chat }); };
  const rest = text
    .replace(CHAT_THEN_IDS, (_, chat: string, ids: string) => { add(ids, chat.toLowerCase()); return " "; })
    .replace(IDS_THEN_CHAT, (_, ids: string, chat: string) => { add(ids, chat.toLowerCase()); return " "; })
    .replace(POSSESSIVE_IDS, (match: string, ids: string, at: number, whole: string) => {
      add(ids, /^['’]s/.test(match) ? chatNamed(whole.slice(0, at), chats) : null);
      return " ";
    });
  return { refs, rest };
}
/** The one chat whose name ends `before` as whole words (the longest name wins), or null when none or several do. */
function chatNamed(before: string, chats: readonly NamedChat[]): string | null {
  const text = before.toLowerCase().trimEnd();
  let best = 0;
  let found = new Set<string>();
  for (const chat of chats) {
    if (chat.archived) continue;
    for (const name of new Set([chat.name.trim().toLowerCase(), chat.name.split(" (")[0]!.trim().toLowerCase()])) {
      if (!name || name.length < best || !text.endsWith(name) || /[a-z0-9]/.test(text[text.length - name.length - 1] ?? "")) continue;
      if (name.length > best) { best = name.length; found = new Set(); }
      found.add(chat.id);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}
/**
 * The open step on another chat's board that the first clause of a step's wait names (`waitRefs`: "<session id> p476", "CI and RepoOps's
 * p476"), if any. Such a wait hands the work to that chat, which owns it: its own check-in, its notices and d9 count that step when nobody moves
 * it, so the waiting step counts once, at the step that carries the blocker. On 10-28 vent's p89 and p94 waited for "the next walked prod
 * release" on an idle job with no wake and read stuck at each d9 run, while CI and RepoOps' p476 "The next production release goes out with
 * the owner's go" carried that release with the release owner.
 */
export function handedStep(item: Pick<PlanItem, "waitFor">, self: ReadonlySet<string>, others: ReadonlyMap<string, ChatBoard | null | undefined>,
  chats: readonly NamedChat[] = []): { chat: string; item: PlanItem } | undefined {
  for (const ref of waitRefs(firstClause(item.waitFor ?? ""), chats).refs) {
    if (ref.chat === null || self.has(ref.chat) || !ref.id.startsWith("p")) continue;
    let found: PlanItem | undefined;
    const visit = (items: readonly PlanItem[]): void => { for (const each of items) { if (each.id === ref.id) found = each; else visit(each.children); } };
    visit(others.get(ref.chat)?.plan ?? []);
    if (found && OPEN_STEP.has(found.status)) return { chat: ref.chat, item: found };
  }
  return undefined;
}
const OPEN_STEP: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);

/** A todo as `holdingTodo` reads it: one of this chat's, or another chat's that a wait here links (`chat`, its session id). */
export type HoldingTodo = Pick<OwnerTodo, "id" | "text" | "step" | "reply" | "done" | "from"> & { chat?: string };

/**
 * The open agent todo that holds the step by an explicit link, if any: it names the step's id, links it (`step`) or a PR it names (`coversStep`),
 * or the step's wait names the todo's id. A shared word is not a link: on 10-14 13 of the 17 steps the classes counted as For you matched only by
 * a word, and four of them waited on a release. A todo that only quotes a step's name is no link either, since a guessed hold can hide a step that
 * is really stuck (c88; tried in a4672f1 for Duties review's p14 and taken back).
 * Another chat's todo (`chat`, from `withLinkedTodos`) holds only a wait that names that chat's session id and the todo id (`waitRefs`), and a
 * bare todo id names only this chat's todo: AI harness p919 waited for "thread:01a16213-54c6-73fa-b399-20e2713c41ba t11", Railway Breach's
 * open ask, while the chat's own t11 was an old closed todo.
 */
export function holdingTodo<T extends HoldingTodo>(item: Pick<PlanItem, "id" | "text" | "waitFor" | "note">, todos: readonly T[]): T | undefined {
  const id = new RegExp(`\\b${item.id}\\b`);
  const wait = item.waitFor ?? "";
  const { refs, rest } = waitRefs(wait);
  const linked = new Set(refs.map(ref => `${ref.chat} ${ref.id}`));
  const own = { ...item, text: waitRefs(item.text).rest, note: item.note && waitRefs(item.note).rest, waitFor: rest } as PlanItem;
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
      for (const ref of waitRefs(item.waitFor ?? "").refs) if (ref.chat && ref.id.startsWith("t")) refs.set(`${ref.chat} ${ref.id}`, { chat: ref.chat, id: ref.id });
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
  return withLinkedBoards(board, self, await linkedBoards(board, self, read));
}
/** The boards of the other chats this board's waits name (`waitRefs`, with names resolved by `chats`), read by `read`; null for one that cannot be read. */
export async function linkedBoards(board: ChatBoard, self: string, read: (chat: string) => Promise<ChatBoard | null | undefined>,
  chats: readonly NamedChat[] = []): Promise<Map<string, ChatBoard | null>> {
  const named = new Set<string>();
  const visit = (items: readonly PlanItem[]): void => {
    for (const item of items) {
      for (const ref of waitRefs(item.waitFor ?? "", chats).refs) if (ref.chat && ref.chat !== self) named.add(ref.chat);
      visit(item.children);
    }
  };
  visit(board.plan);
  return new Map(await Promise.all([...named].map(async chat => [chat, await read(chat).catch(() => null) ?? null] as const)));
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
