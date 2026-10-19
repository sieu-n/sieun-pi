import { boardKey } from "../shared/board-delta.ts";
import type { ChatBoard } from "../shared/types.ts";

/**
 * Each chat's board as this browser last held it, so a later page load or first switch to the chat names it to the feed (`ThreadHave.board`)
 * and gets no board bytes, or a delta, instead of the whole board. On 10-19 a first switch from the Mac pulled 136 KB for 01a11bd7 and 411 KB
 * for 01a1164b. The boards live in IndexedDB, since 01a1164b's alone is about 0.5 MB of localStorage's 5 MB; the key of each sits in
 * localStorage under `BOARD_KEYS`, so the shell's boot script and a subscribe name it with no wait. The key is written after its board.
 */
export const BOARD_KEYS = "chat.boardKeys";

const readKeys = (): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(BOARD_KEYS) ?? "{}");
    return typeof value === "object" && value !== null ? value as Record<string, string> : {};
  } catch { return {}; }
};

export function cachedBoardKey(id: string): string | undefined {
  const key = readKeys()[id];
  return typeof key === "string" ? key : undefined;
}

let opened: Promise<IDBDatabase> | null = null;
const db = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("sieun-pi-boards", 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("boards"); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { opened = null; reject(request.error); };
});

export async function readCachedBoard(id: string): Promise<ChatBoard | null> {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const request = handle.transaction("boards", "readonly").objectStore("boards").get(id);
    request.onsuccess = () => resolve((request.result as ChatBoard | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function cacheBoard(id: string, board: ChatBoard): Promise<void> {
  const key = boardKey(board);
  if (cachedBoardKey(id) === key) return;
  const handle = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = handle.transaction("boards", "readwrite");
    tx.objectStore("boards").put(board, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  try { localStorage.setItem(BOARD_KEYS, JSON.stringify({ ...readKeys(), [id]: key })); } catch { /* Private mode: the next load gets the whole board. */ }
}
