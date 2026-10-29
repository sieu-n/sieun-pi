/**
 * apps/chat's server: `node --import tsx server/main.ts [--port 5184] [--data-dir ~/.pi/agent/chat] [--socket <pi-host socket>] [--fixture]`.
 * With --fixture it runs on a seeded fake host and data dir, with no pi-host, so pages build and test before the real host is wired.
 */
import { mkdtempSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app.ts";
import { fixtureFolders, readAgentHosts, readConfig, type Config } from "./config.ts";
import { FixtureHost } from "./host/fixture.ts";
import { MultiHost, type Box } from "./host/multi-host.ts";
import { PiHost } from "./host/pi-host.ts";
import { RelayHost } from "./host/relay-host.ts";
import type { Host } from "./host/types.ts";
import { projectList } from "./projects.ts";
import { serve } from "./http.ts";
import { seedFixture } from "./fixture/seed.ts";

const config = readConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
if (config.fixture && !process.argv.includes("--data-dir")) config.dataDir = mkdtempSync(join(tmpdir(), "apps-chat-fixture-"));
if (config.fixture) Object.assign(config, fixtureFolders(config.dataDir));
/**
 * One `Host` per box with an agent relay in the hosts registry, and the local pi-host socket for this box until its own relay is listed
 * there, behind one `MultiHost`.
 */
function boxes(config: Config): Host {
  const relays: Box[] = readAgentHosts(config.hostsFile, config.box, log).map(h => ({
    box: h.box, label: h.label, host: new RelayHost({ box: h.box, url: h.url, token: h.token, dataDir: config.dataDir, chatPort: config.port, log }),
  }));
  const all = relays.some(b => b.box === config.box) ? relays : [{ box: config.box, label: config.box, host: new PiHost(config.socket, log) }, ...relays];
  const projects = projectList(config);
  return new MultiHost(config.box, all, config.dataDir, {
    box: config.box, platform: platform(), home: homedir(), projects: projects.projects.map(p => p.path), agentsDir: config.agentsDir,
  }, log);
}

const host = config.fixture ? new FixtureHost() : boxes(config);
if (config.fixture) seedFixture(host as FixtureHost, config.dataDir, Date.now(), config.box);
const app = new App(config, host, log);
await app.start();
const server = serve(app);
server.listen(config.port, config.listen, () => log(`apps/chat on http://${config.listen}:${config.port} (${config.fixture ? "fixture" : `pi-host ${config.socket}`}, data ${config.dataDir})`));

const shutdown = async () => {
  server.close();
  await app.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
