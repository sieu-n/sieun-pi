import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const files = readdirSync(resolve(packageRoot, "test")).filter(name => name.endsWith(".test.ts") && !name.endsWith("native.test.ts")).map(name => `test/${name}`);
const tests = spawn(node, ["--import", "tsx", "--test", ...files], {
  cwd: packageRoot,
  stdio: "inherit",
});
tests.once("error", error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
tests.once("exit", code => { process.exitCode = code ?? 1; });
