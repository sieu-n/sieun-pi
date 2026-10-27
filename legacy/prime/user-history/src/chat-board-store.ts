import { watch as watchDir, type FSWatcher } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { DutyStore } from "./chat-duty-store.ts";
import { dutyKeys } from "./shared/duty-fixes.ts";
import { applyBoardOp, emptyBoard, idsTop, linkStepSessions, nextIds, parseBoard, releaseClosedAsks } from "./shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "./shared/types.ts";

const sessionIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const WATCH_DEBOUNCE_MS = 60;

/**
 * The chat boards, one file per chat at `<dataDir>/boards/<sessionId>.json`. The chat server (owner) and the extension's `chat_board` tool (agent)
 * both write through `apply`, under the cross-process lock in locked-json, so their ops never interleave.
 */
export class BoardStore {
  readonly dir: string;
  private readonly duties: DutyStore;
  constructor(dataDir: string) { this.dir = join(dataDir, "boards"); this.duties = new DutyStore(dataDir); }

  private file(id: string): JsonFile<ChatBoard> {
    if (!sessionIdPattern.test(id)) throw new Error(`Not a session id: ${id}`);
    return { path: join(this.dir, id + ".json"), label: "Chat board", parse: parseBoard, initial: () => emptyBoard(new Date().toISOString()) };
  }

  /** Each board's last parse, with the file's inode, mtime and size then. */
  private readonly parsed = new Map<string, { key: string; board: ChatBoard | null }>();
  /**
   * The board (a v1 file reads as v2), or null before its first op, parsed again only once its file changed: a write replaces the file by
   * rename, so a read without the lock sees a whole board, and a caller never changes the board it gets. On 10-18 the catalog's parses of
   * every chat's board on each projection took 13% of it, and on 10-26 the 30 s ticks' board reads (job cleanup, check-ins, duties) parsed
   * the 16 chats' boards (3.7 MB) about twice a tick, 35 to 60 ms of the main thread a pass, while the chat's reads waited 200 to 385 ms.
   */
  async read(id: string): Promise<ChatBoard | null> {
    let key: string;
    try { const info = await stat(this.file(id).path, { bigint: true }); key = `${info.ino}:${info.mtimeNs}:${info.size}`; }
    catch (error) { if (missing(error)) return null; throw error; }
    const known = this.parsed.get(id);
    if (known?.key === key) return known.board;
    let board: ChatBoard | null;
    try { board = await readJsonFile(this.file(id)); }
    catch (error) { if (!missing(error)) throw error; board = null; }
    this.parsed.set(id, { key, board });
    return board;
  }

  /**
   * Applies the ops in order, all or none: a refused op (BoardError) leaves the file as it was. No ops reads the board. A duty link must name a
   * metric or reading of the chat's duties (`dutyLinkProblem`).
   */
  async apply(id: string, ops: readonly BoardOp[] | ((board: ChatBoard) => readonly BoardOp[]), actor: BoardActor): Promise<{ board: ChatBoard | null; summaries: string[] }> {
    if (typeof ops !== "function" && !ops.length) return { board: await this.read(id), summaries: [] };
    const duties = dutyKeys(await this.duties.list(id));
    const { state, result } = await transactJsonFile(this.file(id), state => {
      const now = new Date().toISOString();
      let board = state;
      const summaries: string[] = [];
      for (const op of typeof ops === "function" ? ops(state) : ops) {
        const given = idsTop(board);
        const next = applyBoardOp(board, op, actor, now, nextIds(board), duties);
        const top = idsTop(next.board);
        board = { ...next.board, lastIds: { p: Math.max(given.p, top.p), t: Math.max(given.t, top.t) } };
        summaries.push(next.summary);
      }
      const released = releaseClosedAsks(state, board, id, now);
      if (released) { board = released.board; summaries.push(...released.summaries); }
      Object.assign(state, board);
      return summaries;
    });
    return { board: state, summaries: result };
  }

  /** Stores the owner's session id on the steps in `links` that have none and still name that job (`linkStepSessions`); writes nothing when none changes. */
  async linkSessions(id: string, links: ReadonlyMap<string, { job: string; sessionId: string }>): Promise<void> {
    if (!links.size) return;
    await transactJsonFile(this.file(id), state => {
      const next = linkStepSessions(state, links, new Date().toISOString());
      if (next) Object.assign(state, next);
    });
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
