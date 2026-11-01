import { Worker } from "node:worker_threads";

/**
 * Rows a worker sends in one message. On 11-01 this box's 8,530-row, 65 MB list came back in batches of 500 with the main thread's timers
 * at most 5 ms late, against 335 ms for one JSON.parse of it.
 */
const BATCH = 500;

/**
 * One full list of the daemon on `socketPath`, read and parsed in a worker thread on a link of its own, as the daemon's `{ sessions }`.
 * On the main thread the 65 MB answer held the event loop 777 ms at 06:24:22Z on 11-01 (the line reader's join and JSON.parse), and the major
 * GC after it 814 ms more, while CI took 25 cores, so the chat's loop stalled 1.6 s in that minute. Structured clone hands the rows over in
 * batches the loop takes between other work.
 */
export function fullListInWorker(socketPath: string, deadlines: { socketMs: number; helloMs: number }, batch = BATCH): Promise<{ sessions: unknown[] }> {
  return new Promise((resolve, reject) => {
    const sessions: unknown[] = [];
    const worker = new Worker(new URL("./full-list-worker.mjs", import.meta.url), { workerData: { socketPath, ...deadlines, batch } });
    worker.unref();
    let settled = false;
    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      if (error) reject(error);
      else resolve({ sessions });
    };
    worker.on("message", (message: { rows: unknown[] } | { done: true } | { error: string }) => {
      if ("rows" in message) for (const row of message.rows) sessions.push(row);
      else settle("error" in message ? new Error(message.error) : null);
    });
    worker.once("error", (error: Error) => settle(error));
    worker.once("exit", code => settle(new Error(`the full list worker exited with code ${code} before it answered`)));
  });
}
