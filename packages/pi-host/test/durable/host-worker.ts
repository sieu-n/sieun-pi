/**
 * One pi-host process for the durable crash test: the real PiHost, socket and DurableThreads, with the model behind
 * pi-pool's provider. Faux mode answers from ./crash-scenario.ts through ../../../pi-pool/test/fake-pool.mjs;
 * real mode asks the real pi-pool for claude-opus-5-5.
 *
 *   node --import tsx pi-host/test/durable/host-worker.ts <socket> <dir> <faux|real>
 *
 * Prints `ready` once the socket listens and recovery ran; logs go to stderr.
 */
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DURABLE_SETTINGS, poolProvider, TurnQueue } from "@sieun-pi/pi-pool/durable";
import { fauxRespond, MODEL } from "./crash-scenario.ts";
import { DurableCommands, DurableThreads } from "../../src/durable/index.ts";
import { PiHost } from "../../src/host.ts";
import { listen } from "../../src/server.ts";

const [socket, dir, mode] = process.argv.slice(2);
if (!socket || !dir || (mode !== "faux" && mode !== "real")) throw new Error("usage: host-worker.ts <socket> <dir> <faux|real>");
const here = dirname(fileURLToPath(import.meta.url));

// HOST_WORKER_POOL_BIN swaps fake-pool.mjs for another hook, such as one that runs the real turn queue in PI_POOL_DIR.
const poolBin = process.env.HOST_WORKER_POOL_BIN;
const fakePool = poolBin ?? join(here, "..", "..", "..", "pi-pool", "test", "fake-pool.mjs");
const turns = mode === "real" ? new TurnQueue() : new TurnQueue({ bin: fakePool, ...(poolBin ? {} : { turnsFile: join(dir, "pool", "turns.json") }) });

function modelsFor(threadId: string) {
  const models = createModels();
  const treeKey = `pi-durable:${threadId}`;
  if (mode === "real") {
    models.setProvider(poolProvider({ treeKey, turns }));
    return models;
  }
  const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }], tokensPerSecond: 40 });
  faux.setResponses(Array.from({ length: 64 }, () => fauxRespond));
  models.setProvider(poolProvider({ treeKey, bin: fakePool, inner: faux.provider, turns }));
  return models;
}

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
const threads = new DurableThreads({ dir: join(dir, "durable"), models: modelsFor, defaultModel: MODEL, defaultThinkingLevel: mode === "real" ? "high" : "off", defaultCwd: dir, log,
  settings: DURABLE_SETTINGS,
  inputSettled: (threadId, session, runContinues) => turns.release({ root: `pi-durable:${threadId}`, session }, runContinues),
  turns: {
    ownerTurn: (threadId, session) => turns.ownerTurn({ root: `pi-durable:${threadId}`, session }),
    ticket: (threadId, session) => turns.ticket({ root: `pi-durable:${threadId}`, session }),
  },
});
const durable = new DurableCommands(threads);
const host = new PiHost({ agentDir: join(dir, "agent"), dataDir: join(dir, "data"), extensions: [], idleUnloadMs: 0, durable, log });
await listen(host, socket);
const recovered = await threads.start();
process.stdout.write(`${JSON.stringify({ event: "ready", recovered })}\n`);
process.on("SIGTERM", () => void host.shutdown().then(() => process.exit(0)));
