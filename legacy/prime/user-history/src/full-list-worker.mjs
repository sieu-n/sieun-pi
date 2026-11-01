// Runs one full list of a daemon's sessions (src/full-list.ts) off the chat server's event loop and sends the rows back in batches.
import { parentPort, workerData } from "node:worker_threads";

const { socketPath, socketMs, helloMs, batch } = workerData;
try {
  // Prime's daemon client alone: the package index loads all of Prime (1.8 s and 147 MB on 11-01), this module 36 ms and 56 MB.
  const { DaemonClient } = await import(new URL("./modes/daemon/daemon-client.js", import.meta.resolve("prime-agent")).href);
  const client = new DaemonClient(socketPath);
  try {
    await client.reconnect(socketMs);
    await client.waitForHello(helloMs);
    const response = await client.request({ type: "list", all: true }, 2 ** 31 - 1, { recoverable: false });
    if (!response.success) throw new Error(response.error);
    const sessions = response.data?.sessions;
    if (!Array.isArray(sessions)) throw new Error("Invalid daemon session catalog");
    for (let at = 0; at < sessions.length; at += batch) parentPort.postMessage({ rows: sessions.slice(at, at + batch) });
    parentPort.postMessage({ done: true });
  } finally {
    client.close();
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
