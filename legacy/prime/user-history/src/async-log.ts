import { fstatSync, write, writeSync } from "node:fs";

type Stream = { fd: number; write: (...args: never[]) => boolean };
type Chunk = { fd: number; bytes: Buffer; done?: (error?: Error | null) => void };

/**
 * Sends the writes of `process.stdout` and `process.stderr` that go to a regular file through libuv's pool, in call order, instead of Node's
 * SyncWriteStream, whose writeSync holds the main thread until the kernel takes the bytes. The 11-03 and 11-04 profiles of the :5182 chat,
 * whose stdout and stderr append to service.log, showed about 8 such waits of 0.4 to 0.7 s. A write starts on the next turn of the event loop
 * and one runs at a time, so the lines of one turn, and those that come in while a write runs, go out together. At exit, or before Node
 * prints an uncaught exception, the lines not yet handed to the pool are written synchronously; a line written in the exit's own turn is
 * never in the pool yet, so the last lines keep their order. A stream that is a TTY or pipe keeps Node's own writer. Returns the fds it took over.
 */
export function asyncFileLogs(streams: Stream[] = [process.stdout, process.stderr], io = { write, writeSync }): number[] {
  const taken = streams.filter(stream => { try { return fstatSync(stream.fd).isFile(); } catch { return false; } });
  if (!taken.length) return [];
  const pending: Chunk[] = [];
  let busy = false, scheduled = false;
  const kick = (): void => { if (!busy && !scheduled && pending.length) { scheduled = true; setImmediate(start); } };
  const start = (): void => {
    scheduled = false;
    if (busy || !pending.length) return;
    const fd = pending[0]!.fd;
    let count = 0;
    while (count < pending.length && pending[count]!.fd === fd) count++;
    const batch = pending.splice(0, count);
    const bytes = batch.length === 1 ? batch[0]!.bytes : Buffer.concat(batch.map(chunk => chunk.bytes));
    busy = true;
    const send = (from: number): void => {
      io.write(fd, bytes, from, bytes.length - from, null, (error, written) => {
        if (!error && from + written < bytes.length) { send(from + written); return; }
        busy = false;
        for (const chunk of batch) chunk.done?.(error);
        kick();
      });
    };
    send(0);
  };
  const flush = (): void => {
    for (const chunk of pending.splice(0)) { try { writeAll(io.writeSync, chunk.fd, chunk.bytes); } catch {} }
  };
  for (const stream of taken) {
    stream.write = ((data: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), done?: (error?: Error | null) => void) => {
      const callback = typeof encoding === "function" ? encoding : done;
      const bytes = typeof data === "string" ? Buffer.from(data, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(data);
      pending.push({ fd: stream.fd, bytes, ...callback ? { done: callback } : {} });
      kick();
      return true;
    }) as Stream["write"];
  }
  process.on("exit", flush);
  process.on("uncaughtExceptionMonitor", flush);
  return taken.map(stream => stream.fd);
}

function writeAll(writeSyncFn: typeof writeSync, fd: number, bytes: Buffer): void {
  for (let from = 0; from < bytes.length;) from += writeSyncFn(fd, bytes, from, bytes.length - from);
}
