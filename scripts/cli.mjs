#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockedPrimeVersion } from "../utils/prime-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
function run(executable, arguments_, cwd = root) {
  const result = spawnSync(executable, arguments_, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
try {
  if (["plan", "apply", "verify", "rollback", "uninstall"].includes(command)) {
    run(process.env.SIEUN_PI_PYTHON || "python3", ["-B", resolve(root, "scripts/manage.py"), command, ...args], process.cwd());
  } else if (command === "daily-recap-setup") {
    run(process.env.SIEUN_PI_PYTHON || "python3", ["-B", resolve(root, "components/daily-recap/install.py"), ...args], process.cwd());
  } else if (command === "chat" || command === "open") {
    // `sieun-pi open` is `sieun-pi chat open`: start the chat if needed, then open its app window or the URL.
    run(process.execPath, [resolve(root, "components/user-history/src/chat-service-cli.mjs"), ...(command === "open" ? ["open"] : []), ...args], process.cwd());
  } else if (command === "source") {
    process.stdout.write(`${root}\n`);
  } else if (command === "sync-prime-agent") {
    run(process.execPath, [resolve(root, "scripts/sync-prime-agent.mjs"), ...args]);
  } else if (command === "check" || command === "build") {
    run(process.execPath, [resolve(root, `scripts/${command}.mjs`), ...args]);
  } else if (command === "develop") {
    if (!existsSync(resolve(root, "package-lock.json"))) throw new Error("Locked development needs a Git checkout. Clone https://github.com/sieu-n/sieun-pi.git and run npm run develop there.");
    run("npm", ["ci", "--ignore-scripts", "--include=dev"]);
    run("uv", ["sync", "--locked"]);
    run("bun", ["install", "--frozen-lockfile"], resolve(root, "skills/poteto-mode/scripts"));
    run("npm", ["ci", "--ignore-scripts"], resolve(root, "components/user-history"));
    run("npm", ["ci", "--ignore-scripts"], resolve(root, "components/daily-recap"));
  } else {
    process.stdout.write(`sieun-pi (Prime Agent ${lockedPrimeVersion(root)})\n\nCommands: open, chat, source, develop, check, build, plan, apply, verify, rollback, uninstall, sync-prime-agent, daily-recap-setup\nRun a profile command with --help for options. Install and update never change HOME automatically.\n`);
    if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`sieun-pi: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
