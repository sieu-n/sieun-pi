// Guards the 10-18 owner report on us-metal02 ("the web server sieu-pi keep crashing"): the chat restarted 42 times by 06:15Z, each time refusing
// connections for the 3 to 11 s stop plus the 3.5 to 5.7 s boot. sieun-pi-chat.socket now holds port 5182, and release-chat switches it in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { takeListenFd } from "../src/listen-fd.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repo, "scripts/release-chat.mjs");
const units = join(repo, "deploy/linux");

test("the serve takes fd 3 only when LISTEN_PID names it, and clears the variables for its helpers", () => {
  const env: NodeJS.ProcessEnv = { LISTEN_FDS: "1", LISTEN_PID: "42", LISTEN_FDNAMES: "sieun-pi-chat.socket" };
  assert.equal(takeListenFd(env, 42), 3);
  assert.deepEqual(env, {});
  assert.equal(takeListenFd({ LISTEN_FDS: "1", LISTEN_PID: "41" }, 42), null);
  assert.equal(takeListenFd({}, 42), null);
});

test("a release whose units differ installs them and moves the port to the socket; the next one only restarts", t => {
  const dir = mkdtempSync(join(tmpdir(), "release-socket-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = join(dir, "repo");
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q", git], ["-C", git, "commit", "-q", "--allow-empty", "-m", "release"]]) assert.equal(spawnSync("git", args, { env: gitEnv }).status, 0);
  const sha = spawnSync("git", ["-C", git, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const home = join(dir, "home");
  const unitDir = join(dir, "units");
  const release = join(home, `release-${sha.slice(0, 7)}`);
  mkdirSync(join(release, "deploy/linux"), { recursive: true });
  for (const name of ["sieun-pi-chat.service", "sieun-pi-chat.socket"]) writeFileSync(join(release, "deploy/linux", name), readFileSync(join(units, name)));
  writeFileSync(join(release, "release.json"), JSON.stringify({ sha }));
  mkdirSync(unitDir);
  writeFileSync(join(unitDir, "sieun-pi-chat.service"), "[Unit]\nDescription=the unit before sockets\n");
  const calls = join(dir, "calls.log");
  const systemctl = join(dir, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
  const env = { ...process.env, SIEUN_PI_CHAT_HOME: home, SIEUN_PI_CHAT_SERVICE_MANAGER: "systemd", SIEUN_PI_CHAT_SYSTEMCTL: systemctl, SIEUN_PI_CHAT_UNIT_DIR: unitDir };
  const release1 = spawnSync(process.execPath, [script, `release-${sha.slice(0, 7)}`, "--rollback", "--repo", git], { env, encoding: "utf8" });
  assert.equal(release1.status, 0, release1.stderr);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    "--user daemon-reload", "--user stop sieun-pi-chat.service", "--user enable --now sieun-pi-chat.socket", "--user start sieun-pi-chat.service"]);
  for (const name of ["sieun-pi-chat.service", "sieun-pi-chat.socket"]) assert.equal(readFileSync(join(unitDir, name), "utf8"), readFileSync(join(units, name), "utf8"));
  rmSync(calls);
  // A second release of the same commit is a no-op since 2793dfa3d, so the next release is a new commit on top.
  assert.equal(spawnSync("git", ["-C", git, "commit", "-q", "--allow-empty", "-m", "next"], { env: gitEnv }).status, 0);
  const next = spawnSync("git", ["-C", git, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const nextRelease = join(home, `release-${next.slice(0, 7)}`);
  mkdirSync(join(nextRelease, "deploy/linux"), { recursive: true });
  for (const name of ["sieun-pi-chat.service", "sieun-pi-chat.socket"]) writeFileSync(join(nextRelease, "deploy/linux", name), readFileSync(join(units, name)));
  writeFileSync(join(nextRelease, "release.json"), JSON.stringify({ sha: next }));
  const release2 = spawnSync(process.execPath, [script, `release-${next.slice(0, 7)}`, "--rollback", "--repo", git], { env, encoding: "utf8" });
  assert.equal(release2.status, 0, release2.stderr);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["--user restart sieun-pi-chat.service"]);
});
