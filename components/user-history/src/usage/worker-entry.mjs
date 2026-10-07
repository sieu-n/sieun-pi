// The worker thread runs TypeScript the same way chat-service-cli.mjs does: tsx registers first, then the module loads.
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
