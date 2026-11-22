// Guards the 11-22 wiki releases on us-metal02: the wiki moved into the container box-sieun-pi-wiki-1 at 23:33Z on 11-21, and
// release-wiki.mjs still restarted sieun-pi-wiki.service, which crash-looped on EADDRINUSE :5176, so each release failed its up-check.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/release-wiki.mjs");

// docker and systemctl log each call. docker inspect reads the release that current names, and reports a stopped container for one
// whose release.json says crash, as a wiki that exits after its first answers would leave it.
const FAKE = (name) => `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const path = require("node:path");
const dir = path.dirname(__filename);
appendFileSync(path.join(dir, "calls.log"), ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "inspect") {
  const release = JSON.parse(readFileSync(path.join(process.env.HOME, ".local/share/sieun-pi-wiki/current/release.json"), "utf8"));
  process.stdout.write((release.crash ? "false" : "true") + " 2026-11-22T00:00:00Z\\n");
}
`;

async function rig(releases) {
  const root = mkdtempSync(path.join(tmpdir(), "release-wiki-"));
  const home = path.join(root, "home");
  const wiki = path.join(home, ".local/share/sieun-pi-wiki");
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["docker", "systemctl"]) {
    writeFileSync(path.join(bin, name), FAKE(name));
    chmodSync(path.join(bin, name), 0o755);
  }
  for (const [name, release] of Object.entries(releases)) {
    mkdirSync(path.join(wiki, name, "apps/wiki"), { recursive: true });
    writeFileSync(path.join(wiki, name, "release.json"), JSON.stringify(release));
  }
  symlinkSync(Object.keys(releases)[0], path.join(wiki, "current"));
  const server = createServer((req, res) => {
    const release = JSON.parse(readFileSync(path.join(realpathSync(path.join(wiki, "current")), "release.json"), "utf8"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/wiki/health" ? { status: "ok", revision: release.sha } : { ok: true }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const run = (...args) => new Promise(done => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, WIKI_PORT: String(server.address().port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("close", code => done({ code, out }));
  });
  const calls = () => { try { return readFileSync(path.join(bin, "calls.log"), "utf8").trim().split("\n"); } catch { return []; } };
  const close = () => { server.close(); rmSync(root, { recursive: true, force: true }); };
  return { run, calls, current: () => readlinkSync(path.join(wiki, "current")), close };
}

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("release-wiki restarts the Komodo container", { concurrency: true }, () => {
  test("a release restarts box-sieun-pi-wiki-1 and never the old systemd unit", async () => {
    const r = await rig({ "release-aaaaaaa": { sha: A }, "release-bbbbbbb": { sha: B } });
    try {
      const { code, out } = await r.run("release-bbbbbbb", "--rollback");
      assert.equal(code, 0, out);
      assert.equal(r.current(), "release-bbbbbbb");
      assert.ok(r.calls().includes("docker restart box-sieun-pi-wiki-1"), r.calls().join("\n"));
      assert.deepEqual(r.calls().filter(call => call.startsWith("systemctl")), []);
    } finally { r.close(); }
  });

  test("a container that does not stay up sends current back and restarts it on the release before", async () => {
    const r = await rig({ "release-aaaaaaa": { sha: A }, "release-bbbbbbb": { sha: B, crash: true } });
    try {
      const { code, out } = await r.run("release-bbbbbbb", "--rollback");
      assert.equal(code, 5, out);
      assert.equal(r.current(), "release-aaaaaaa");
      assert.equal(r.calls().filter(call => call === "docker restart box-sieun-pi-wiki-1").length, 2, r.calls().join("\n"));
    } finally { r.close(); }
  });
});
