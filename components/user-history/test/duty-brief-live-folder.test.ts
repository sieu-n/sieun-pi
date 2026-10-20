// On 10-20 d2's precheck cwd named the pruned release-b8c6bba after a job ran add.ts from the release path its duty brief gave it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveFolder } from "../src/chat-duty-job.ts";

test("a duty brief names a release folder through the current link, and any other folder as it is", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "duty-brief-live-")), "sieun-pi-chat");
  try {
    await mkdir(join(root, "release-a", "components", "user-history"), { recursive: true });
    assert.equal(liveFolder(join(root, "release-a", "components", "user-history")), join(root, "release-a", "components", "user-history"));
    await symlink("release-a", join(root, "current"));
    assert.equal(liveFolder(join(root, "release-a", "components", "user-history")), join(root, "current", "components", "user-history"));
    assert.equal(liveFolder("/home/u/src/sieun-pi/components/user-history"), "/home/u/src/sieun-pi/components/user-history");
  } finally { await rm(join(root, ".."), { recursive: true, force: true }); }
});
