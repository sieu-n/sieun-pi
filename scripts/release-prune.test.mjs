// A release folder a live process still runs in survives the prune of the next release.
// Run: node --test --test-force-exit --test-isolation=none scripts/release-prune.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prune, releasesInUse } from "./release-prune.mjs";

const NAME = /^release-([0-9a-f]{7,40})$/;

test("the prune keeps an old release a live process runs in and removes the others", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "release-prune-")));
  for (const name of ["release-aaaaaaa", "release-bbbbbbb", "release-ccccccc", "release-ddddddd"]) mkdirSync(join(home, name, "apps", "chat"), { recursive: true });
  mkdirSync(join(home, "notes"));
  // A duty precheck started from the old release's apps/chat, as d4's after-job precheck ran on 11-23.
  const precheck = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: join(home, "release-aaaaaaa", "apps", "chat"), stdio: "ignore" });
  try {
    await new Promise(done => precheck.once("spawn", done));
    assert.deepEqual([...releasesInUse(home)], ["release-aaaaaaa"]);
    const held = prune(home, NAME, ["release-ddddddd", "release-ccccccc"]);
    assert.deepEqual(held, ["release-aaaaaaa"]);
    assert.ok(existsSync(join(home, "release-aaaaaaa", "apps", "chat")), "the release the precheck runs in stays");
    assert.ok(!existsSync(join(home, "release-bbbbbbb")), "an unused old release goes");
    assert.ok(existsSync(join(home, "release-ccccccc")) && existsSync(join(home, "release-ddddddd")) && existsSync(join(home, "notes")));
  } finally {
    precheck.kill();
    await new Promise(done => precheck.once("exit", done));
  }
  // Once the precheck ended, the next prune removes it.
  assert.deepEqual(prune(home, NAME, ["release-ddddddd", "release-ccccccc"]), []);
  assert.ok(!existsSync(join(home, "release-aaaaaaa")));
  rmSync(home, { recursive: true, force: true });
});
