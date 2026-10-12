// Preloaded with `--import` into `sieun-pi chat` commands. Inside a chat serve it replaces net.Server listen, so the serve loads, records
// itself and opens its data directory, then never binds its port: SILENT_SERVE_MODE=hang never answers, fail reports EACCES. It writes its
// PID to SILENT_SERVE_PID_FILE. Every other process (the CLI wrapper, `chat start`, `chat stop`) runs untouched.
import { writeFileSync } from "node:fs";
import net from "node:net";

if (process.argv[2] === "serve") {
  writeFileSync(process.env.SILENT_SERVE_PID_FILE, String(process.pid));
  net.Server.prototype.listen = function listen() {
    if (process.env.SILENT_SERVE_MODE === "fail") process.nextTick(() => this.emit("error", Object.assign(new Error("listen EACCES (silent-serve fixture)"), { code: "EACCES" })));
    return this;
  };
}
