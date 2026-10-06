import { watch as watchDir, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { applyBoardOp, emptyBoard, nextIds } from "./shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "./shared/types.ts";

const sessionIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const WATCH_DEBOUNCE_MS = 60;

function parseBoard(value: unknown): ChatBoard {
  const board = value as ChatBoard;
  if (typeof value !== "object" || value === null || board.v !== 1 || typeof board.rev !== "number" || !Array.isArray(board.plan) || !Array.isArray(board.todos) ||
    typeof board.scratchpad !== "string") throw new Error("Chat board file is malformed.");
  return board;
}

/**
 * The chat boards, one file per chat at `<dataDir>/boards/<sessionId>.json`. The chat server (owner) and the extension's `chat_board` tool (agent)
 * both write through `apply`, under the cross-process lock in locked-json, so their ops never interleave.
 */
export class BoardStore {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = join(dataDir, "boards"); }

  private file(id: string): JsonFile<ChatBoard> {
    if (!sessionIdPattern.test(id)) throw new Error(`Not a session id: ${id}`);
    return { path: join(this.dir, id + ".json"), label: "Chat board", parse: parseBoard, initial: () => emptyBoard(new Date().toISOString()) };
  }

  /** The board, or null before its first op. Writes replace the file by rename, so a read without the lock sees a whole board. */
  async read(id: string): Promise<ChatBoard | null> {
    try { return await readJsonFile(this.file(id)); }
    catch (error) { if (missing(error)) return null; throw error; }
  }

  /** Applies the ops in order, all or none: a refused op (BoardError) leaves the file as it was. No ops reads the board. */
  async apply(id: string, ops: readonly BoardOp[], actor: BoardActor): Promise<{ board: ChatBoard | null; summaries: string[] }> {
    if (!ops.length) return { board: await this.read(id), summaries: [] };
    const { state, result } = await transactJsonFile(this.file(id), state => {
      const now = new Date().toISOString();
      let board = state;
      const summaries: string[] = [];
      for (const op of ops) {
        const next = applyBoardOp(board, op, actor, now, nextIds(board));
        board = next.board;
        summaries.push(next.summary);
      }
      Object.assign(state, board);
      return summaries;
    });
    return { board: state, summaries: result };
  }

  /**
   * Calls `onBoard` with a chat's board shortly after its file changes, from either writer. Creates the boards directory so there is something to
   * watch. Returns the stop function.
   */
  watch(onBoard: (id: string, board: ChatBoard) => void, onError: (error: unknown) => void = () => {}): () => void {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let watcher: FSWatcher | undefined;
    let stopped = false;
    const changed = (name: string) => {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!sessionIdPattern.test(id)) return;
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        void this.read(id).then(board => { if (board && !stopped) onBoard(id, board); }, onError);
      }, WATCH_DEBOUNCE_MS));
    };
    void mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => {
      if (stopped) return;
      watcher = watchDir(this.dir, (_event, name) => { if (name) changed(name.toString()); });
      watcher.on("error", onError);
    }, onError);
    return () => {
      stopped = true;
      watcher?.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }
}
