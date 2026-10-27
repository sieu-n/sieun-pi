#!/usr/bin/env node
// Installs pi-history from a commit: node packages/pi-history/install.mjs [--ref <sha>] [--ssh <user@host>]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARE = join(homedir(), ".local/share/pi-history");
const LABEL = "com.sieun.pi-history";

const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts }) ?? "").trim();

/** The node on PATH, kept as a link so a node upgrade behind it does not break the unit. */
function nodePath() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "node"))) return join(dir, "node");
  }
  return process.execPath;
}

function fill(template) {
  return readFileSync(join(HERE, "deploy", template), "utf8")
    .replaceAll("@NODE@", nodePath())
    .replaceAll("@MAIN@", join(SHARE, "current", "src", "main.ts"))
    .replaceAll("@HOME@", homedir());
}

/** Points current at release-<sha> and restarts the service from it, on the box this runs on. */
function activate(sha) {
  const release = join(SHARE, `release-${sha}`);
  if (!existsSync(join(release, "src", "main.ts"))) throw new Error(`no release at ${release}`);
  const next = join(SHARE, `current.${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(release, next);
  renameSync(next, join(SHARE, "current"));
  if (platform() === "darwin") {
    const plist = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    mkdirSync(join(homedir(), "Library/Logs"), { recursive: true });
    writeFileSync(plist, fill(`${LABEL}.plist`));
    const domain = `gui/${process.getuid()}`;
    spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
    run("launchctl", ["bootstrap", domain, plist]);
  } else {
    const unit = join(homedir(), ".config/systemd/user/pi-history.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, fill("pi-history.service"));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "pi-history.service"], { stdio: "ignore" });
    run("systemctl", ["--user", "restart", "pi-history.service"]);
  }
  console.log(`pi-history ${sha} is live from ${release}`);
}

/** git archive of packages/pi-history at the commit, as a tar buffer. */
function archive(sha) {
  const repo = run("git", ["-C", HERE, "rev-parse", "--show-toplevel"]);
  return execFileSync("git", ["-C", repo, "archive", "--format=tar", `${sha}:packages/pi-history`], { maxBuffer: 1 << 30 });
}

function exportLocal(sha) {
  const release = join(SHARE, `release-${sha}`);
  if (existsSync(release)) return;
  mkdirSync(SHARE, { recursive: true });
  const tmp = mkdtempSync(join(SHARE, ".export-"));
  execFileSync("tar", ["-x", "-C", tmp], { input: archive(sha) });
  renameSync(tmp, release);
}

function exportRemote(sha, host) {
  const release = `.local/share/pi-history/release-${sha}`;
  const script = `set -e; if [ ! -d ${release} ]; then mkdir -p ${release}.tmp && tar -x -C ${release}.tmp && mv ${release}.tmp ${release}; else cat > /dev/null; fi`;
  execFileSync("ssh", [host, script], { input: archive(sha), stdio: ["pipe", "inherit", "inherit"] });
  execFileSync("ssh", [host, `zsh -lc 'node ${release}/install.mjs --activate ${sha}'`], { stdio: "inherit" });
}

const { values } = parseArgs({ options: { ref: { type: "string" }, ssh: { type: "string" }, activate: { type: "string" } } });
if (values.activate) activate(values.activate);
else {
  const sha = run("git", ["-C", HERE, "rev-parse", "--short=12", values.ref ?? "HEAD"]);
  if (values.ssh) exportRemote(sha, values.ssh);
  else {
    exportLocal(sha);
    activate(sha);
  }
}
