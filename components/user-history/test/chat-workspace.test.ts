import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspace, WorkspaceError } from "../src/chat-workspace.ts";

test("workspace paths expand ~, normalise, and must name an existing folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-workspace-"));
  try {
    await mkdir(join(home, "code", "app"), { recursive: true });
    await writeFile(join(home, "notes.txt"), "x");
    assert.equal(await resolveWorkspace("~", home), home);
    assert.equal(await resolveWorkspace("  ~/code/app/ ", home), join(home, "code", "app"));
    assert.equal(await resolveWorkspace(join(home, "code", "..", "code", "app"), home), join(home, "code", "app"));
    await assert.rejects(resolveWorkspace("~/code/missing", home), (error: unknown) => error instanceof WorkspaceError && /No folder at ~\/code\/missing/.test(error.message));
    await assert.rejects(resolveWorkspace("/Documents/Github/definitely-missing", home), /No folder at/);
    await assert.rejects(resolveWorkspace("~/notes.txt", home), /is a file, not a folder/);
    await assert.rejects(resolveWorkspace("code/app", home), /Start the path with \/ or ~\//);
    await assert.rejects(resolveWorkspace("~other/app", home), /Start the path with/);
    await assert.rejects(resolveWorkspace("   ", home), /Type a folder path/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
