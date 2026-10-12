import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { profileStart } from "../src/start-profile.ts";

test("profileStart: a request file profiles the start for its seconds, writes a .cpuprofile and is used once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "start-profile-"));
  await writeFile(join(dir, "start-profile.request"), "0.2\n");
  const run = await profileStart(["serve", "--data-dir", dir]);
  assert.ok(run, "a request starts the profiler");
  assert.equal(existsSync(join(dir, "start-profile.request")), false, "the request is used once");
  let sum = 0;
  for (let index = 0; index < 2e6; index++) sum += Math.sqrt(index);
  assert.ok(sum > 0);
  const path = await run.done;
  assert.match(path, /start-.*\.cpuprofile$/);
  const profile = JSON.parse(await readFile(path, "utf8"));
  assert.ok(profile.nodes.length > 1 && profile.samples.length > 0);
  assert.deepEqual((await readdir(join(dir, "profiles"))).length, 1);
});

test("profileStart: no request, no data dir or no seconds start nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "start-profile-"));
  assert.equal(await profileStart(["serve", "--data-dir", dir]), null);
  assert.equal(await profileStart(["serve"]), null);
  await writeFile(join(dir, "start-profile.request"), "soon");
  assert.equal(await profileStart(["serve", "--data-dir", dir]), null);
  assert.equal(existsSync(join(dir, "start-profile.request")), false);
});
