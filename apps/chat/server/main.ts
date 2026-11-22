/**
 * apps/chat's server: `node --import tsx server/main.ts [--port 5184] [--data-dir ~/.pi/agent/chat] [--socket <pi-host socket>] [--fixture]`.
 * With --fixture it runs on a seeded fake host and data dir, with no pi-host, so pages build and test before the real host is wired.
 */
import { mkdtempSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app.ts";
import { flushSync, onWriteError, seal } from "./disk.ts";
import { fixtureFolders, readAgentHosts, readConfig, type Config } from "./config.ts";
import { FixtureHost } from "./host/fixture.ts";
import { MultiHost, type Box } from "./host/multi-host.ts";
import { PiHost } from "./host/pi-host.ts";
import { RelayHost } from "./host/relay-host.ts";
import type { Host } from "./host/types.ts";
import { projectList } from "./projects.ts";
import { drain, lingerForwarding, serve, skillsParts, windDown, WRITE_WAIT_MS } from "./http.ts";
import { seedFixture } from "./fixture/seed.ts";
import { boostBeforeStop, DataLock, handOverOnHangup, listening, reclaimMain, startWatchdog, tellSystemd } from "./handoff.ts";

const loadedMs = Math.round(performance.now());
const config = readConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
onWriteError(log);
process.on("exit", flushSync);
let app: App | undefined;
let stopping: Promise<void> | undefined;
const stopApp = () => (stopping ??= app ? app.stop().catch(() => undefined) : Promise.resolve());
/** A hand-over's stop: the app keeps its pi-host client for the reads it still finishes, and every later write is dropped before the lock moves. */
const handOverStop = async () => {
  await (stopping ??= app ? app.stop({ keepHost: true }).catch(() => undefined) : Promise.resolve());
  seal("this server handed the data dir to its successor");
};
let server: ReturnType<typeof serve> | undefined;
const shutdown = async () => {
  if (server) log(`stop: ${await drain(server)}`);
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
// systemd's ExecReload sends SIGHUP to the main process, which a successor is from its MAINPID= on; until it serves, a reload is left out.
const earlyHangup = () => log("handoff: a reload came before this process took the port; it is left out");
if (port.predecessor) process.on("SIGHUP", earlyHangup);
const boostAt = performance.now();
if (port.predecessor) {
  try {
    await boostBeforeStop(log);
  } catch (error) {
    // The running server still serves and still is the main process, so this successor only ends.
    log(`systemd-notify: ${error instanceof Error ? error.message : String(error)}; this process exits`);
    process.exit(1);
  }
}
const boostMs = Math.round(performance.now() - boostAt);
const waitedAt = performance.now();
if (port.predecessor) {
  if ((await port.predecessor.stopped()) === "gone") log("handoff: the running server ended before its stop; this process takes the data dir");
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
const builtMs = Math.round(performance.now() - startAt);
const started = await app.start({ loops: false });
// A fixture server fills its own search index at once, so its first search does not wait for it.
if (config.fixture) void app.searchEngine.start().catch(() => undefined);
const servedAt = performance.now();
const http = (server = serve(app, skills));
const routesMs = Math.round(performance.now() - servedAt);
const fd = port.fd;
await new Promise<void>(resolve => (fd === null ? http.listen(config.port, config.listen, resolve) : http.listen({ fd }, resolve)));
log(`apps/chat on http://${config.listen}:${config.port}${fd === null ? "" : ` through fd ${fd}`} (${config.fixture ? "fixture" : `pi-host ${config.socket}`}, data ${config.dataDir}); ` +
  `modules ${loadedMs} ms, skills ${skillsMs} ms${port.predecessor ? `, main process and core scope ${boostMs} ms, the old server's stop ${waitedMs} ms` : ""}, state and start ${Math.round(performance.now() - startAt)} ms (state read ${builtMs} ms, ${started}, routes ${routesMs} ms)`);
// The loops start once the queued calls had their answers, and after cpu-protect.py's next 2 s pass (INTERVAL_S) moved this process into the
// unit's core scope, where their scan of every room's posts runs at its weight.
setTimeout(() => { if (!stopping) log(`loops: started in ${app!.startLoops()} ms`); }, 2000);
if (!port.predecessor) {
  try {
    await tellSystemd(false, log);
  } catch (error) {
    log(`systemd-notify: ${error instanceof Error ? error.message : String(error)}; this process exits`);
    process.exit(1);
  }
}
const quiet = startWatchdog(log);
port.predecessor?.taken();
process.off("SIGHUP", earlyHangup);
if (fd !== null) handOverOnHangup({ fd, server: http, drain: server => drain(server, WRITE_WAIT_MS, "forward"), linger: () => lingerForwarding(http), windDown: on => windDown(http, on), stop: handOverStop, unlock: () => lock.release(), quiet, log, exit: code => process.exit(code), reclaim: () => reclaimMain(log) });
