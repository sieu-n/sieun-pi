// p661 (10-31): the units vent-lat-cold and dmext-slow-b of two pi threads named no owner on us-metal02, so the d2 orphan reaper could not
// tell them from a finished job's leftovers. A pi kernel tags its processes with LC_PRIME_SESSION, and its systemd-run passes the tag on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownerTag, UNIT_TAG_DIR } from "../../src/durable/rlm.ts";

const THREAD = "39ca7bbb-37a8-47e5-a06a-d6cea515b3cc";

test("a kernel's env names its thread and short host, and puts the unit-tag shim first on PATH", () => {
  assert.deepEqual(ownerTag(THREAD, "/venv/bin:/usr/bin", ":", "us-metal02.tail0c093d.ts.net"),
    { LC_PRIME_SESSION: `${THREAD}@us-metal02`, PATH: `${UNIT_TAG_DIR}:/venv/bin:/usr/bin` });
});

test("the shim passes LC_PRIME_SESSION to the next systemd-run on PATH, and adds nothing without it", () => {
  const root = mkdtempSync(join(tmpdir(), "unit-tag-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    const run = (env: Record<string, string>) => spawnSync(join(UNIT_TAG_DIR, "systemd-run"), ["--user", "--unit=t", "sleep", "1"],
      { encoding: "utf8", env: { PATH: `${UNIT_TAG_DIR}:${bin}:/usr/bin:/bin`, ...env } });
    const tagged = run({ LC_PRIME_SESSION: `${THREAD}@us-metal02` });
    assert.equal(tagged.status, 0, tagged.stderr);
    assert.deepEqual(tagged.stdout.trim().split("\n"), ["-E", "LC_PRIME_SESSION", "--user", "--unit=t", "sleep", "1"]);
    assert.deepEqual(run({}).stdout.trim().split("\n"), ["--user", "--unit=t", "sleep", "1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
