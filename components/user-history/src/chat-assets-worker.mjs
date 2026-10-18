// The client bundle compiles here, off the chat server's event loop. TypeScript loads the way chat-service-cli.mjs does it.
import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { compileClient } = await import("./chat-assets.ts");
try {
  const { js, css } = await compileClient();
  parentPort.postMessage({ ok: true, js, css });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
