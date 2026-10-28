/**
 * apps/chat's server: `node --import tsx server/main.ts [--port 5184] [--data-dir ~/.pi/agent/chat] [--socket <pi-host socket>] [--fixture]`.
 * With --fixture it runs on a seeded fake host and data dir, with no pi-host, so pages build and test before the real host is wired.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app.ts";
import { fixtureFolders, readConfig } from "./config.ts";
import { FixtureHost } from "./host/fixture.ts";
import { PiHost } from "./host/pi-host.ts";
import { serve } from "./http.ts";
import { seedFixture } from "./fixture/seed.ts";

const config = readConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
if (config.fixture && !process.argv.includes("--data-dir")) config.dataDir = mkdtempSync(join(tmpdir(), "apps-chat-fixture-"));
if (config.fixture) Object.assign(config, fixtureFolders(config.dataDir));
const host = config.fixture ? new FixtureHost() : new PiHost(config.socket, log);
if (config.fixture) seedFixture(host as FixtureHost, config.dataDir);
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
