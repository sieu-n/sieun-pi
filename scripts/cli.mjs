#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  } else if (command === "source") {
    process.stdout.write(`${root}\n`);
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
    process.stdout.write("sieun-pi (Prime Agent 0.9.4)\n\nCommands: source, develop, check, build, plan, apply, verify, rollback, uninstall, daily-recap-setup\nRun a profile command with --help for options. Install and update never change HOME automatically.\n");
    if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`sieun-pi: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
