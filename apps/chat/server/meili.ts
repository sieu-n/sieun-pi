/**
 * A Meilisearch client for the one search index (search-engine.ts), and a private Meilisearch process for a fixture server or a test.
 * The live server talks to the meilisearch.service systemd user unit (deploy/linux/meilisearch.service, scripts/install-meilisearch.mjs).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface MeiliTask { taskUid: number }
export interface MeiliTaskState { uid: number; status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled"; error?: { message: string } | null }
export interface MeiliSearchAnswer<T> { hits: T[]; totalHits: number; processingTimeMs: number }

export class MeiliError extends Error {}

export class Meili {
  constructor(readonly url: string, private readonly key: string) {}

  async call<T>(method: string, path: string, body?: unknown, written = false): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: written ? String(body) : JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new MeiliError(`Meilisearch ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Creates the index if it is missing; a second create answers a failed task, which is fine. */
  async ensureIndex(uid: string, settings: Record<string, unknown>): Promise<void> {
    await this.waitTask(await this.call<MeiliTask>("POST", "/indexes", { uid, primaryKey: "id" }));
    const task = await this.waitTask(await this.call<MeiliTask>("PATCH", `/indexes/${uid}/settings`, settings));
    if (task.status !== "succeeded") throw new MeiliError(`Meilisearch refused the ${uid} settings: ${task.error?.message ?? task.status}`);
  }

  /** `docs` is the JSON array of documents, written once by the caller, which measured its size against Meilisearch's payload limit. */
  put(uid: string, docs: string): Promise<MeiliTask> {
    return this.call<MeiliTask>("POST", `/indexes/${uid}/documents`, docs, true);
  }

  deleteWhere(uid: string, filter: string): Promise<MeiliTask> {
    return this.call<MeiliTask>("POST", `/indexes/${uid}/documents/delete`, { filter });
  }

  deleteIds(uid: string, ids: readonly string[]): Promise<MeiliTask> {
    return this.call<MeiliTask>("POST", `/indexes/${uid}/documents/delete-batch`, ids);
  }

  async fetch<T>(uid: string, ids: readonly string[], fields: readonly string[]): Promise<T[]> {
    if (!ids.length) return [];
    return (await this.call<{ results: T[] }>("POST", `/indexes/${uid}/documents/fetch`, { ids, fields, limit: ids.length })).results;
  }

  search<T>(uid: string, body: Record<string, unknown>): Promise<MeiliSearchAnswer<T>> {
    return this.call<MeiliSearchAnswer<T>>("POST", `/indexes/${uid}/search`, body);
  }

  /** The tasks among `uids` that are done, succeeded or not. */
  async done(uids: readonly number[]): Promise<MeiliTaskState[]> {
    if (!uids.length) return [];
    const page = await this.call<{ results: MeiliTaskState[] }>("GET", `/tasks?uids=${uids.join(",")}&statuses=succeeded,failed,canceled&limit=${uids.length}`);
    return page.results;
  }

  /** Waits for one task by polling it; Meilisearch has no other way to say a task finished short of its webhook. */
  async waitTask(task: MeiliTask): Promise<MeiliTaskState> {
    for (let pause = 5; ; pause = Math.min(pause * 2, 200)) {
      const state = await this.call<MeiliTaskState>("GET", `/tasks/${task.taskUid}`);
      if (state.status !== "enqueued" && state.status !== "processing") return state;
      await new Promise(resolve => setTimeout(resolve, pause));
    }
  }
}

/** The Meilisearch binary: MEILISEARCH_BIN, else the one scripts/install-meilisearch.mjs installs, else `meilisearch` on PATH. */
export function meiliBin(env = process.env): string {
  if (env.MEILISEARCH_BIN) return env.MEILISEARCH_BIN;
  const installed = join(homedir(), ".local/opt/meilisearch/current/meilisearch");
  return existsSync(installed) ? installed : "meilisearch";
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    server.close(() => resolve(port));
  });
});

export interface OwnMeili { meili: Meili; stop(): void }

/** A Meilisearch process of this server's own on a free loopback port, with its data in a temp folder that `stop` removes. */
export async function startOwnMeili(bin = meiliBin()): Promise<OwnMeili> {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-meili-"));
  const key = randomBytes(16).toString("hex");
  const port = await freePort();
  const child: ChildProcess = spawn(bin, ["--http-addr", `127.0.0.1:${port}`, "--db-path", join(dir, "data.ms"), "--dump-dir", join(dir, "dumps"),
    "--master-key", key, "--no-analytics", "--env", "development"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let failed: Error | undefined;
  child.on("error", error => (failed = error));
  child.stderr?.on("data", chunk => (stderr = (stderr + String(chunk)).slice(-2000)));
  const stop = () => {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", stop);
  const meili = new Meili(`http://127.0.0.1:${port}`, key);
  for (let pause = 10; ; pause = Math.min(pause * 2, 200)) {
    if (failed) throw new MeiliError(`Meilisearch (${bin}) did not start: ${failed.message}`);
    if (child.exitCode !== null) throw new MeiliError(`Meilisearch (${bin}) exited ${child.exitCode}: ${stderr}`);
    try {
      await meili.call("GET", "/health");
      return { meili, stop };
    } catch {
      await new Promise(resolve => setTimeout(resolve, pause));
    }
  }
}
