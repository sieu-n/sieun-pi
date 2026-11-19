/**
 * deploy/linux/meilisearch-warm.service reads every index file under the Meilisearch data folder back into the page cache, and its timer
 * runs it every two minutes. On 11-19 the first search of the day took 75 ms in Meilisearch against about 10 ms for the next ones, since
 * the box had dropped the index file's pages during the idle day; with every page dropped a search took 101 ms with 294 major faults.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const deploy = join(import.meta.dirname, "../../../../deploy/linux");
const read = (name: string): string => (existsSync(join(deploy, name)) ? readFileSync(join(deploy, name), "utf8") : "");
const PAGES = 2048;

/** The file's pages in the page cache, as `fincore` counts them. */
const cached = (file: string): number => Number(execFileSync("fincore", ["--noheadings", "--output", "PAGES", file], { encoding: "utf8" }).trim());

test("the warm unit's command reads a dropped index file back into the page cache", { skip: process.platform !== "linux" || !existsSync("/usr/bin/fincore") }, () => {
  const start = /^ExecStart=\/bin\/sh -c '(.+)'$/m.exec(read("meilisearch-warm.service"))?.[1];
  assert.ok(start, "meilisearch-warm.service has an ExecStart that runs a shell command");
  // /var/tmp is on a disk; /tmp is a tmpfs on us-metal02, whose pages are never dropped.
  const home = mkdtempSync("/var/tmp/meili-warm-test-");
  try {
    const files = ["a", "b"].map(index => join(home, ".local/share/meilisearch/data.ms/indexes", index, "data.mdb"));
    for (const file of files) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, Buffer.alloc(PAGES * 4096, 1), { flush: true });
      // GNU dd's way to drop one file's pages from the cache, once they are on disk.
      execFileSync("dd", [`of=${file}`, "oflag=nocache", "conv=notrunc", "count=0"], { stdio: "ignore" });
      assert.equal(cached(file), 0, "the file's pages are dropped before the read");
    }
    execFileSync("/bin/sh", ["-c", start.replaceAll("%h", home)]);
    for (const file of files) assert.equal(cached(file), PAGES);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the timer runs the warm unit every two minutes and the install script starts it", () => {
  const timer = read("meilisearch-warm.timer");
  assert.match(timer, /^OnUnitActiveSec=2min$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  const install = readFileSync(join(deploy, "../../scripts/install-meilisearch.mjs"), "utf8");
  for (const name of ["meilisearch-warm.service", "meilisearch-warm.timer"]) assert.ok(install.includes(`"${name}"`), `install-meilisearch.mjs copies ${name}`);
  assert.ok(install.includes('"enable", "--now", "meilisearch-warm.timer"'));
});
