import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}

try {
  run(process.execPath, ["scripts/check.mjs"]);
  const output = join(root, "dist");
  mkdirSync(output, { recursive: true });
  for (const skill of ["websearch", "linear-ticket", "aside-browser"]) {
    run("uv", ["build", "--wheel", "--project", `skills/${skill}`, "--out-dir", output]);
  }
  console.log(`\nBuilt Python wheels in ${output}:`);
  for (const file of readdirSync(output).filter((name) => name.endsWith(".whl")).sort()) console.log(file);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", output]);
  console.log("Built the source npm tarball and Python wheels. TypeScript and MJS stay as source for the Prime extension loader.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
