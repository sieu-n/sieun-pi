// 10-18 on us-metal02: Node's recursive fs.watch on Linux put an inotify watch on every file under session-artifacts, 167,548 in the
// chat's usage worker for 154k artifact files, and the worker spent about 0.7 of a core on their events.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ingest } from "../src/usage/ingest.ts";
import { fileRoots } from "../src/usage/sources.ts";
import type { FileRow, UsageStore } from "../src/usage/store.ts";

/** This process's inotify watches, summed over its inotify descriptors. */
function inotifyWatches(): number {
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try { if (readlinkSync(`/proc/self/fd/${fd}`) !== "anon_inode:inotify") continue; } catch { continue; }
    count += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").split("\n").filter(line => line.startsWith("inotify ")).length;
  }
  return count;
}
const waitFor = async (check: () => boolean): Promise<void> => {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 20))) if (Date.now() - started > 5000) throw new Error("timed out");
};

test("on Linux the usage ingest watches only the folders that hold transcripts, and a job folder made later is watched too", { skip: process.platform !== "linux" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-watch-"));
  const artifacts = join(home, ".prime", "agent", "session-artifacts");
  const job = join(artifacts, "01a1root", "sub-a");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "01a1job.jsonl"), "");
  for (let folder = 0; folder < 20; folder++) {
    const files = join(artifacts, "01a1root", "files", `f${folder}`);
    mkdirSync(files, { recursive: true });
    for (let file = 0; file < 25; file++) writeFileSync(join(files, `a${file}.txt`), "x");
  }
  const written: FileRow[] = [];
  const store = { fresh: false, resetSources: async () => [], files: async () => [], write: async (_calls: unknown[], files: FileRow[]) => { written.push(...files); },
    models: async () => [], setPrices: async () => {} } as unknown as UsageStore;
  const before = inotifyWatches();
  const ingest = new Ingest({ store, roots: fileRoots(home), databases: [], pricesPath: join(home, "prices.json"), debounceMs: 50, fetchPrices: () => Promise.reject(new Error("offline")) });
  try {
    await ingest.start();
    await ingest.idle();
    await waitFor(() => inotifyWatches() - before >= 3);
    assert.equal(inotifyWatches() - before, 3, "session-artifacts, the root job folder and its sub-a, never the 520 artifact files and folders");
    const later = join(artifacts, "01a1root", "sub-a", "sub-b");
    mkdirSync(later);
    await waitFor(() => inotifyWatches() - before === 4);
    appendFileSync(join(later, "01a1child.jsonl"), "{}\n");
    await waitFor(() => written.some(row => row.path === join(later, "01a1child.jsonl")));
  } finally { ingest.close(); }
});
