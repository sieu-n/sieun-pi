/**
 * apps/chat's server: `node --import tsx server/main.ts [--port 5184] [--data-dir ~/.pi/agent/chat] [--socket <pi-host socket>] [--fixture]`.
 * With --fixture it runs on a seeded fake host and data dir, with no pi-host, so pages build and test before the real host is wired.
 */
import { mkdtempSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app.ts";
import { flushSync, onWriteError } from "./disk.ts";
import { fixtureFolders, readAgentHosts, readConfig, type Config } from "./config.ts";
import { FixtureHost } from "./host/fixture.ts";
import { MultiHost, type Box } from "./host/multi-host.ts";
import { PiHost } from "./host/pi-host.ts";
import { RelayHost } from "./host/relay-host.ts";
import type { Host } from "./host/types.ts";
import { projectList } from "./projects.ts";
import { drain, serve, skillsParts } from "./http.ts";
import { seedFixture } from "./fixture/seed.ts";
import { DataLock, handOverOnHangup, listening, startWatchdog, tellSystemd } from "./handoff.ts";

const loadedMs = Math.round(performance.now());
const config = readConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
onWriteError(log);
process.on("exit", flushSync);
let app: App | undefined;
let stopping: Promise<void> | undefined;
const stopApp = () => (stopping ??= app ? app.stop().catch(() => undefined) : Promise.resolve());
let server: ReturnType<typeof serve> | undefined;
const shutdown = async () => {
  if (server) await drain(server);
  await stopApp();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
if (config.fixture && !process.argv.includes("--data-dir")) config.dataDir = mkdtempSync(join(tmpdir(), "apps-chat-fixture-"));
if (config.fixture) Object.assign(config, fixtureFolders(config.dataDir));
const port = listening();
const lock = new DataLock(join(config.dataDir, "server.lock"));
const takeLock = () => {
  const held = lock.take();
  if (!held) return;
  log(`data dir: ${held}; this server does not serve it and exits`);
  process.exit(1);
};
if (!port.predecessor) takeLock();
// The skills DB's first ingest runs before the port is taken, and for a successor while the old server still serves (http.ts skillsParts).
const skillsAt = performance.now();
const skills = skillsParts(config, log, () => app);
await skills.ready;
const skillsMs = Math.round(performance.now() - skillsAt);
// A successor reads the data dir only once the server it follows stopped and wrote its files (server/handoff.ts).
const waitedAt = performance.now();
if (port.predecessor) {
  await port.predecessor.stopped();
  takeLock();
}
const waitedMs = Math.round(performance.now() - waitedAt);
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
const startAt = performance.now();
app = new App(config, host, log);
await app.start();
// A fixture server fills its own search index at once, so its first search does not wait for it.
if (config.fixture) void app.searchEngine.start().catch(() => undefined);
const http = (server = serve(app, skills));
const fd = port.fd;
await new Promise<void>(resolve => (fd === null ? http.listen(config.port, config.listen, resolve) : http.listen({ fd }, resolve)));
log(`apps/chat on http://${config.listen}:${config.port}${fd === null ? "" : ` through fd ${fd}`} (${config.fixture ? "fixture" : `pi-host ${config.socket}`}, data ${config.dataDir}); ` +
  `modules ${loadedMs} ms, skills ${skillsMs} ms${port.predecessor ? `, the old server's stop ${waitedMs} ms` : ""}, state and start ${Math.round(performance.now() - startAt)} ms`);
try {
  await tellSystemd(port.predecessor !== null, log);
} catch (error) {
  // systemd must take a successor as the main process before the old server exits, or it reads that exit as the unit's end.
  log(`systemd-notify: ${error instanceof Error ? error.message : String(error)}; this process exits`);
  process.exit(1);
}
startWatchdog(log);
port.predecessor?.taken();
if (fd !== null) handOverOnHangup({ fd, server: http, drain, stop: stopApp, unlock: () => lock.release(), log, exit: code => process.exit(code) });
