// The client bundle compiles here, off the chat server's event loop. TypeScript loads the way chat-service-cli.mjs does it.
import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { compileAndPack } = await import("./chat-assets.ts");
try {
  parentPort.postMessage({ ok: true, ...await compileAndPack() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
