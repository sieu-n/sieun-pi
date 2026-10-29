import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { AllowedModel } from "../../../config/allowed-models.ts";

/** A new thread's model when none is named: the newest Opus, one of config/allowed-models.ts (c185). */
export const DEFAULT_MODEL: AllowedModel = "anthropic/claude-opus-5-5";

/** Today's chat, which this server ports from. One constant, so its move to legacy/prime/user-history is a one-line edit. */
export const USER_HISTORY_DIR = "legacy/prime/user-history";

export interface Config {
  port: number;
  listen: string;
  dataDir: string;
  socket: string;
  /** pi-host's index.sqlite, which search reads on its own read-only connection; none on the fixture host. */
  durableIndex?: string;
  fixture: boolean;
  webDir: string;
  box: string;
  /** Prime's shared chat data, read only: the corrections ledger and the hosts registry. */
  sharedDir: string;
  wikiBase: string;
  version: string;
  /** The home folder, which the server refuses as a thread's cwd: no project's AGENTS.md, skills or rules load there. */
  home: string;
  /** Project checkouts a new agent can run in, first the default; `server/projects.ts` keeps the ones on this box. */
  projects: string[];
  /** Where each agent's folder (`<slug>/brief.md`, `<slug>/harness/`) lives on this box: `APPS_CHAT_AGENTS_DIR`, else `~/.pi/agent/agents`. */
  agentsDir: string;
  /**
   * Whether this server writes the `agent.ref` doc into its agents' threads. A test server on the live pi-host turns it off, because its
   * temporary agents would point live threads at a temporary folder.
   */
  agentRefs: boolean;
}

/** The checkouts the agents work in on the Linux box and the Mac; APPS_CHAT_PROJECTS (colon-separated) replaces the list. */
export function defaultProjects(home: string): string[] {
  return [join(home, "src/sieun-pi"), join(home, "Documents/Github/auto-sns-agent"), join(home, "Documents/Github/sieun-pi")];
}

/** The fixture's home folder, projects and agent folders, under its data dir, as `seedFixture` creates them. */
export function fixtureFolders(dataDir: string): Pick<Config, "home" | "projects" | "agentsDir"> {
  return { home: join(dataDir, "home"), projects: [join(dataDir, "work", "harness"), join(dataDir, "work", "crawler")], agentsDir: join(dataDir, "agent-folders") };
}

export function readConfig(argv = process.argv.slice(2), env = process.env): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      listen: { type: "string" },
      "data-dir": { type: "string" },
      socket: { type: "string" },
      "durable-index": { type: "string" },
      fixture: { type: "boolean" },
      "web-dir": { type: "string" },
      version: { type: "string" },
    },
  });
  const appDir = resolve(import.meta.dirname, "..");
  const fixture = values.fixture ?? env.APPS_CHAT_FIXTURE === "1";
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const home = homedir();
  const dataDir = resolve(values["data-dir"] ?? env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  return {
    port: Number(values.port ?? env.APPS_CHAT_PORT ?? 5184),
    listen: values.listen ?? "127.0.0.1",
    dataDir,
    socket: values.socket ?? env.PI_HOST_SOCKET ?? join(runtime, "pi-host/host.sock"),
    ...(fixture ? {} : { durableIndex: resolve(values["durable-index"] ?? env.PI_HOST_DURABLE_INDEX ?? join(homedir(), ".prime/agent/pi-host/durable/index.sqlite")) }),
    fixture,
    webDir: resolve(values["web-dir"] ?? join(appDir, "web/dist")),
    box: env.APPS_CHAT_BOX ?? hostname(),
    sharedDir: env.AGENT_CHAT_SHARED_DIR ?? join(homedir(), ".prime/agent/browser-chat"),
    wikiBase: env.APPS_CHAT_WIKI_BASE ?? "https://us-metal02-dev.tail0c093d.ts.net:5176",
    version: values.version ?? env.APPS_CHAT_VERSION ?? releaseVersion(appDir),
    home,
    projects: env.APPS_CHAT_PROJECTS ? env.APPS_CHAT_PROJECTS.split(":").filter(Boolean) : defaultProjects(home),
    agentsDir: resolve(env.APPS_CHAT_AGENTS_DIR ?? (fixture ? join(dataDir, "agent-folders") : join(home, ".pi/agent/agents"))),
    agentRefs: true,
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
