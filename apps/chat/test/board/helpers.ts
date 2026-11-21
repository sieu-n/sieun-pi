import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, type APIRequestContext } from "@playwright/test";
import WebSocket from "ws";

export const HARNESS = "0f1e0000-0000-4000-8000-000000000002";
export const VENT = "0f1e0000-0000-4000-8000-000000000001";
export const CRAWLER = "0f1e0000-0000-4000-8000-000000000003";
/** The agents that hold those work threads (server/fixture/seed.ts FIXTURE_AGENTS); For you and board links name a board by its agent. */
export const HARNESS_AGENT = "ag_ai-harness-developer-environment-vp";
export const CRAWLER_AGENT = "ag_crawler-vp";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

async function startFixtureServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-board-"));
  const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--fixture", "--port", String(port), "--data-dir", dataDir], {
    cwd: join(import.meta.dirname, "../.."),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => (stderr = (stderr + String(chunk)).slice(-2000)));
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  };
  for (;;) {
    if (child.exitCode !== null) {
      rmSync(dataDir, { recursive: true, force: true });
      throw new Error(`the fixture server exited ${child.exitCode}: ${stderr}`);
    }
    if (await fetch(`${url}/api/sidebar`).then(r => r.ok, () => false)) return { url, stop };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Board specs change the fixture's asks, duties and check-ins, and every board change reaches every open page live. Two spec files that
 * shared one fixture server reset and answered each other's asks mid-test, so each worker runs its own fixture server and its pages' /api
 * and /wiki calls and the live socket go there. `chatServer` is that server's URL for the spec's own requests.
 */
export const test = base.extend<{ chatServer: string }, { workerServer: string }>({
  workerServer: [async ({}, use) => {
    const { url, stop } = await startFixtureServer();
    try { await use(url); } finally { await stop(); }
  }, { scope: "worker" }],
  chatServer: async ({ workerServer }, use) => { await use(workerServer); },
  context: async ({ context, workerServer, baseURL }, use) => {
    const web = new URL(baseURL!).host.replace(/[.]/g, "\\.");
    const target = new URL(workerServer);
    const ours = new RegExp(`^(http|ws)://${web}/(api|wiki)([/?]|$)`);
    const swap = (raw: string, protocol: string) => {
      const url = new URL(raw);
      url.protocol = protocol;
      url.host = target.host;
      return url.toString();
    };
    await context.route(ours, route => route.continue({ url: swap(route.request().url(), "http:") }));
    await context.routeWebSocket(ours, route => {
      const upstream = new WebSocket(swap(route.url(), "ws:"));
      const early: (string | Buffer)[] = [];
      upstream.on("open", () => { for (const message of early.splice(0)) upstream.send(message); });
      upstream.on("message", (data, binary) => route.send(binary ? (data as Buffer) : String(data)));
      upstream.on("close", () => void route.close().catch(() => undefined));
      upstream.on("error", () => void route.close().catch(() => undefined));
      route.onMessage(message => (upstream.readyState === WebSocket.OPEN ? upstream.send(message) : early.push(message)));
      route.onClose(() => upstream.close());
    });
    await use(context);
  },
});
export { expect } from "@playwright/test";

async function post(request: APIRequestContext, server: string, path: string, data: unknown) {
  const response = await request.post(server + path, { data });
  if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

/** Put the asks, duties and check-ins the specs change back to the fixture's seed, so each spec starts from the seed on its worker's server. */
export async function resetFixture(request: APIRequestContext, server: string): Promise<void> {
  const open = (id: string) => ({ op: "todo_update", id, done: false, reply: null });
  await post(request, server, `/api/threads/${HARNESS}/board`, { ops: [open("t1"), open("t2"), { op: "todo_update", id: "t3", done: true, reply: "yes" }] });
  await post(request, server, `/api/threads/${CRAWLER}/board`, { ops: [open("t1")] });
  await post(request, server, `/api/threads/${VENT}/board`, { ops: [open("t1")] });
  await post(request, server, `/api/threads/${HARNESS}/duties`, { duty: "d1", action: "resume" });
  await post(request, server, `/api/threads/${HARNESS}/duties`, { duty: "d2", action: "pause" });
  for (const chat of [HARNESS, VENT, CRAWLER]) await post(request, server, `/api/threads/${chat}/check-in`, { pause: null, everyMs: 120 * 60_000 });
}
