// The alert bridge's Grafana poll and status file (src/alert-poll.ts) on their own thread. TypeScript loads the way chat-service-cli.mjs does it.
import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { runPoll } = await import("./alert-poll.ts");
runPoll(workerData, frame => parentPort.postMessage(frame), listener => parentPort.on("message", frame => { if (frame?.type === "alerting") listener(frame.alerting); }),
  line => parentPort.postMessage({ type: "log", line }));
