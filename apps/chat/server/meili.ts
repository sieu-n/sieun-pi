/**
 * A Meilisearch client for the one search index (search-engine.ts), and a private Meilisearch process for a fixture server or a test.
 * The live server talks to the Meilisearch on 127.0.0.1:7700 that the Komodo container box-sieun-pi-meilisearch-1 runs on us-metal02
 * (auto-sns-agent apps/infra/box/compose.sieun-pi.yml, scripts/install-meilisearch.mjs).
 */
import { constants as bufferConstants } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface MeiliTask { taskUid: number }
export interface MeiliTaskState { uid: number; status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled"; error?: { message: string } | null }
export interface MeiliSearchAnswer<T> { hits: T[]; totalHits: number; processingTimeMs: number }

export class MeiliError extends Error {}

/**
 * The longest answer `call` reads. V8 makes no string longer than `MAX_STRING_LENGTH` (0x1fffffe8, 512 MiB), and an answer past it made
 * Buffer.toString throw ERR_STRING_TOO_LONG outside any promise, which ended release af53200 twice on 11-24 (10:02:44Z, 10:03:06Z): a search
 * asked for all 482,189 documents at once, about 4 KB each (the 81,651 hits of "search" alone came to 326 MB). Such an answer is refused.
 */
export const ANSWER_BYTES = bufferConstants.MAX_STRING_LENGTH;

/** Hits a page of `searchEach` asks for: 2,000 of the newest documents came to 4.1 MB on 11-24, so a page stays near 2 MB. */
const PAGE_HITS = 1_000;

export class Meili {
  private readonly agent = new Agent({ keepAlive: true });
  pageHits = PAGE_HITS;
  constructor(readonly url: string, private readonly key: string, readonly answerBytes = ANSWER_BYTES) {}

  /**
   * One request over node:http with a keep-alive agent. fetch took 47 to 56 ms for two of every three searches on 11-03 against 2 ms of
   * Meilisearch's own processing, the 40 ms of a delayed ACK; node:http took 4 to 6 ms for the same search.
   */
  call<T>(method: string, path: string, body?: unknown, written = false): Promise<T> {
    const payload = body === undefined ? undefined : written ? String(body) : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest(new URL(path, this.url), {
        method, agent: this.agent,
        headers: { authorization: `Bearer ${this.key}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) },
      }, response => {
        const tooLong = (bytes: number) => {
          reject(new MeiliError(`Meilisearch ${method} ${path} answered ${bytes} bytes or more, past the ${this.answerBytes} one answer may hold`));
          response.destroy();
        };
        const announced = Number(response.headers["content-length"] ?? 0);
        if (announced > this.answerBytes) return tooLong(announced);
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.answerBytes) return tooLong(bytes);
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new MeiliError(`Meilisearch ${method} ${path} answered ${status}: ${text.slice(0, 300)}`));
          try {
            resolve((text ? JSON.parse(text) : undefined) as T);
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
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

  /**
   * Every hit of a search, newest first, `pageHits` at a time, handed to `each`; answers how many there were. Each page starts below the last
   * one's oldest `at`, since an offset makes Meilisearch walk the hits before it: page 200 of 2,000 took 14.6 s on 11-24 and page 1 0.18 s.
   */
  async searchEach<T extends { id: string; at: number }>(uid: string, body: { q: string; filter: string } & Record<string, unknown>, each: (hits: T[]) => void): Promise<number> {
    let count = 0;
    let last: number | undefined;
    let atLast: string[] = [];
    for (;;) {
      const below = last === undefined ? [] : [`at <= ${last}`, ...(atLast.length ? [`NOT id IN [${atLast.map(id => JSON.stringify(id)).join(", ")}]`] : [])];
      const filter = [...(body.filter ? [`(${body.filter})`] : []), ...below].join(" AND ");
      const { hits } = await this.search<T>(uid, { ...body, filter, sort: ["at:desc"], offset: 0, limit: this.pageHits });
      count += hits.length;
      each(hits);
      if (hits.length < this.pageHits) return count;
      const at = hits.at(-1)!.at;
      atLast = [...(at === last ? atLast : []), ...hits.filter(hit => hit.at === at).map(hit => hit.id)];
      last = at;
    }
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
