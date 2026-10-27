// release-chat.mjs runs this in a release folder before it goes live: the packed client bundle and the diagram renderer go to .client-bundle (chat-assets.ts PREBUILT_DIR).
import { register } from "tsx/esm/api";

register();
const { PREBUILT_DIR, writePrebuilt } = await import("./chat-assets.ts");
const { writeRenderer } = await import("./chat-render.ts");
await writePrebuilt();
await writeRenderer();
process.stdout.write(`client bundle and diagram renderer written to ${PREBUILT_DIR}\n`);
