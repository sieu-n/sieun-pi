import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Today's chat, which this server ports from. One constant, so its move to legacy/prime/user-history is a one-line edit. */
export const USER_HISTORY_DIR = "legacy/prime/user-history";

export interface Config {
  port: number;
  listen: string;
  dataDir: string;
  socket: string;
  fixture: boolean;
  webDir: string;
  box: string;
  /** Prime's shared chat data, read only: the corrections ledger and the hosts registry. */
  sharedDir: string;
  wikiBase: string;
  version: string;
}

export function readConfig(argv = process.argv.slice(2), env = process.env): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      listen: { type: "string" },
      "data-dir": { type: "string" },
      socket: { type: "string" },
      fixture: { type: "boolean" },
      "web-dir": { type: "string" },
      version: { type: "string" },
    },
  });
  const appDir = resolve(import.meta.dirname, "..");
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return {
    port: Number(values.port ?? env.APPS_CHAT_PORT ?? 5184),
    listen: values.listen ?? "127.0.0.1",
    dataDir: resolve(values["data-dir"] ?? env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat")),
    socket: values.socket ?? env.PI_HOST_SOCKET ?? join(runtime, "pi-host/host.sock"),
    fixture: values.fixture ?? env.APPS_CHAT_FIXTURE === "1",
    webDir: resolve(values["web-dir"] ?? join(appDir, "web/dist")),
    box: env.APPS_CHAT_BOX ?? hostname(),
    sharedDir: env.AGENT_CHAT_SHARED_DIR ?? join(homedir(), ".prime/agent/browser-chat"),
    wikiBase: env.APPS_CHAT_WIKI_BASE ?? "https://us-metal02-dev.tail0c093d.ts.net:5176",
    version: values.version ?? env.APPS_CHAT_VERSION ?? releaseVersion(appDir),
  };
}

/** The release's short sha from the release.json scripts/release-apps-chat.mjs writes at the release root, else "dev". */
function releaseVersion(appDir: string): string {
  try {
    return String((JSON.parse(readFileSync(join(appDir, "../../release.json"), "utf8")) as { sha: string }).sha).slice(0, 7);
  } catch {
    return "dev";
  }
}
