import { register } from "tsx/esm/api";

register();

/** The early shell's own process (src/early-shell.ts `serveEarlyChild`); chat-service-cli.mjs starts it with systemd's socket at fd 3. */
const { serveEarlyChild } = await import("./early-shell.ts");
await serveEarlyChild(JSON.parse(process.argv[2] ?? "{}"));
