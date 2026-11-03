#!/usr/bin/env node
/**
 * Installs Meilisearch for apps/chat search on this Linux box, as a systemd user unit with no container:
 * 1. The pinned release binary, checked against its sha256, under ~/.local/opt/meilisearch/v<version>, with `current` pointing at it.
 * 2. A master key, made once, in ~/.config/meilisearch/master.key (the chat reads it) and ~/.config/meilisearch/env (the unit reads it).
 * 3. deploy/linux/meilisearch.service in ~/.config/systemd/user, enabled and started, and a wait for its /health.
 *
 * Usage: node scripts/install-meilisearch.mjs. Run it again to move to a new pinned version; it keeps the key and the data.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const VERSION = "1.56.1";
const SHA256 = "b2c7a647d4cdfdd7a901466bfd6797077b849e90f5eb2c0f5b1d05869592e27e";
const RELEASE_URL = `https://github.com/meilisearch/meilisearch/releases/download/v${VERSION}/meilisearch-linux-amd64`;
const home = homedir();
const opt = join(home, ".local/opt/meilisearch");
const bin = join(opt, `v${VERSION}`, "meilisearch");
const config = join(home, ".config/meilisearch");
const unit = join(home, ".config/systemd/user/meilisearch.service");
const repo = join(import.meta.dirname, "..");

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (!existsSync(bin) || sha(bin) !== SHA256) {
  mkdirSync(dirname(bin), { recursive: true });
  const response = await fetch(RELEASE_URL);
  if (!response.ok) throw new Error(`GET ${RELEASE_URL} answered ${response.status}`);
  const tmp = `${bin}.download`;
  writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
  if (sha(tmp) !== SHA256) {
    rmSync(tmp);
    throw new Error(`${RELEASE_URL} has sha256 ${sha(tmp)}, not the pinned ${SHA256}`);
  }
  chmodSync(tmp, 0o755);
  renameSync(tmp, bin);
}
rmSync(join(opt, "current"), { force: true });
symlinkSync(`v${VERSION}`, join(opt, "current"));

mkdirSync(config, { recursive: true, mode: 0o700 });
const keyFile = join(config, "master.key");
if (!existsSync(keyFile)) writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
const key = readFileSync(keyFile, "utf8").trim();
writeFileSync(join(config, "env"), `MEILI_MASTER_KEY=${key}\n`, { mode: 0o600 });
mkdirSync(join(home, ".local/share/meilisearch"), { recursive: true });

mkdirSync(dirname(unit), { recursive: true });
copyFileSync(join(repo, "deploy/linux/meilisearch.service"), unit);
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "meilisearch.service"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "restart", "meilisearch.service"], { stdio: "inherit" });

for (let pause = 50; ; pause = Math.min(pause * 2, 1000)) {
  try {
    const health = await fetch("http://127.0.0.1:7700/health");
    if (health.ok) break;
  } catch {
    // Not listening yet.
  }
  const state = execFileSync("systemctl", ["--user", "is-active", "meilisearch.service"], { encoding: "utf8" }).trim();
  if (state === "failed") throw new Error("meilisearch.service failed; read `journalctl --user -u meilisearch.service`");
  await new Promise(resolve => setTimeout(resolve, pause));
}
console.log(`meilisearch ${VERSION} is up on 127.0.0.1:7700 (${bin})`);
