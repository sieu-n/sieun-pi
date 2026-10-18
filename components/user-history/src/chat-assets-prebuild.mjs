// release-chat.mjs runs this in a release folder before it goes live: the packed client bundle goes to .client-bundle (chat-assets.ts PREBUILT_DIR).
import { register } from "tsx/esm/api";

register();
const { PREBUILT_DIR, writePrebuilt } = await import("./chat-assets.ts");
await writePrebuilt();
process.stdout.write(`client bundle written to ${PREBUILT_DIR}\n`);
