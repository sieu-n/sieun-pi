// Guards the 10-19 steady main thread: the session file lookup of the agent outbox read and parsed the session's prompt capture (its whole
// last request, 0.3 to 1.9 MB) on every send, even when the daemon listed the file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROMPTS_DIR } from "../src/prompt-capture.ts";
import { sessionFileFor } from "../src/prompt-view.ts";

const SESSION = "01a151b3-8253-779f-a8b9-9a38ce3cec40";

test("a listed session's file is found without reading its prompt capture", { skip: process.platform === "win32" && "uses mkfifo", timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "session-file-for-"));
  const capture = join(dir, PROMPTS_DIR, `${SESSION}.json`);
  t.after(async () => {
    // A read still waiting on the pipe gets its end here, so the test process can exit.
    try { closeSync(openSync(capture, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* nobody reads it */ }
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, PROMPTS_DIR));
  // A pipe with no writer: reading the capture waits until the test ends.
  execFileSync("mkfifo", [capture]);
  const listed = join(dir, "listed.jsonl");
  await writeFile(listed, "{}\n");
  const found = await Promise.race([sessionFileFor(SESSION, { listed: async () => listed, dataDir: dir, agentDir: dir }),
    new Promise(resolve => setTimeout(resolve, 2000, "waited on the capture"))]);
  assert.equal(found, listed);
});
