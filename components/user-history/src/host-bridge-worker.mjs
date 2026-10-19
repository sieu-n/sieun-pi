// The bridge sockets of HostBridge (src/hosts.ts) on their own thread, for src/host-bridge-thread.ts. TypeScript loads the way alert-poll-worker.mjs does it.
import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { HostBridge } = await import("./hosts.ts");
const bridge = new HostBridge(workerData.registry, { ...workerData.options, log: line => parentPort.postMessage({ type: "log", line }) });
parentPort.on("message", frame => { if (frame?.type === "close") void bridge.close().finally(() => parentPort.postMessage({ type: "closed" })); });
bridge.start().then(({ live }) => parentPort.postMessage({ type: "started", live }),
  error => parentPort.postMessage({ type: "failed", error: error instanceof Error ? error.message : String(error) }));
