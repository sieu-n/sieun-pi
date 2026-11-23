// Runs scripts/install-pi-host-box.mjs against a temp home, a temp git repo and a fake pi-host socket, never the box's own pi-host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { chatUrlFor, installPiHost, layout, plist, serviceEnv, systemdUnit } from "../scripts/install-pi-host-box.mjs";

const dirs = [];
const temp = name => { const dir = mkdtempSync(join(tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A pi-host stand-in that says hello and answers every command with an empty thread list. */
function fakeHost(socket) {
  const server = createServer(conn => {
    conn.setEncoding("utf8");
    conn.write(`${JSON.stringify({ type: "daemon_hello" })}\n`);
    let buffer = "";
    conn.on("data", chunk => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
        const { id } = JSON.parse(buffer.slice(0, i));
        conn.write(`${JSON.stringify({ type: "response", id, success: true, data: { threads: [] } })}\n`);
      }
    });
  });
  return new Promise(done => server.listen(socket, () => done(server)));
}

/** A temp home whose `current` points at the release of a one-commit repo's HEAD, with the unit the installer would write. */
function liveBox() {
  const repo = temp("repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"]);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const home = temp("home");
  const paths = layout(home, "linux");
  mkdirSync(join(paths.root, `release-${sha.slice(0, 7)}`, "packages"), { recursive: true });
  symlinkSync(`release-${sha.slice(0, 7)}`, paths.current);
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(paths.unitFile, systemdUnit(paths, process.execPath, serviceEnv(home, process.execPath, undefined)));
  return { repo, sha, home, paths, socket: join(temp("sock"), "host.sock") };
}

test("a commit that is live already with the same unit and a live socket installs and restarts nothing", { skip: process.platform !== "linux" }, async () => {
  const box = liveBox();
  const server = await fakeHost(box.socket);
  const unit = readFileSync(box.paths.unitFile, "utf8");
  try {
    const result = await installPiHost({ repo: box.repo, ref: box.sha, home: box.home, node: process.execPath, socket: box.socket, restart: false });
    assert.equal(result.live, true);
    assert.equal(result.restarted, undefined);
    assert.deepEqual({ threads: result.answered.threads }, { threads: 0 });
    assert.equal(readlinkSync(box.paths.current), `release-${box.sha.slice(0, 7)}`);
    assert.equal(readFileSync(box.paths.unitFile, "utf8"), unit);
  } finally {
    server.close();
  }
});

test("a live commit whose unit changed or whose socket does not answer goes through the boot check again", { skip: process.platform !== "linux" }, async () => {
  const changed = liveBox();
  const server = await fakeHost(changed.socket);
  writeFileSync(changed.paths.unitFile, "# an older unit\n");
  try {
    // The temp release has no pi-host, so the boot check fails, which shows the install went past the no-op. restart: false keeps the
    // box's own pi-host.service out of reach even if a boot check passed.
    await assert.rejects(installPiHost({ repo: changed.repo, ref: changed.sha, home: changed.home, node: process.execPath, socket: changed.socket, restart: false }), /during the boot check/);
  } finally {
    server.close();
  }
  const silent = liveBox();
  await assert.rejects(installPiHost({ repo: silent.repo, ref: silent.sha, home: silent.home, node: process.execPath, socket: silent.socket, restart: false }), /during the boot check/);
});

test("a Mac install points PI_HOST_CHAT_URL at the agent relay's chat proxy", () => {
  const home = temp("mac");
  assert.equal(chatUrlFor(home, "darwin"), "http://127.0.0.1:7792");
  mkdirSync(join(home, ".config/pi-host-relay"), { recursive: true });
  writeFileSync(join(home, ".config/pi-host-relay/relay.json"), JSON.stringify({ chatProxyPort: 7799 }));
  assert.equal(chatUrlFor(home, "darwin"), "http://127.0.0.1:7799");
  assert.equal(chatUrlFor(home, "linux"), undefined);
  const rendered = plist(layout(home, "darwin"), "/usr/local/bin/node", serviceEnv(home, "/usr/local/bin/node", chatUrlFor(home, "darwin")));
  assert.match(rendered, /<key>PI_HOST_CHAT_URL<\/key><string>http:\/\/127\.0\.0\.1:7799<\/string>/);
});
