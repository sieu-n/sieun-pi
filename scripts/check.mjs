import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", ".work", ".venv", "node_modules", "dist", "__pycache__", ".test-artifacts", ".pytest_cache", ".cache"]);

function run(command, args, cwd = root) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function requireFile(path, setup) {
  if (!existsSync(join(root, path))) throw new Error(`Missing ${path}. Run ${setup}.`);
}

try {
  requireFile(".venv/bin/python", "uv sync --locked");
  requireFile("node_modules/typescript/bin/tsc", "npm ci --ignore-scripts");
  requireFile("node_modules/prime-agent/dist/index.d.ts", "npm ci --ignore-scripts");
  requireFile("components/daily-recap/node_modules/sunsama-api/package.json", "npm ci --ignore-scripts --prefix components/daily-recap");
  requireFile("components/user-history/node_modules/tsx/dist/cli.mjs", "npm ci --ignore-scripts --prefix components/user-history");
  requireFile("skills/poteto-mode/scripts/node_modules/typescript/bin/tsc", "cd skills/poteto-mode/scripts && bun install --frozen-lockfile");
  const host = JSON.parse(readFileSync(join(root, "node_modules/prime-agent/package.json"), "utf8"));
  if (host.name !== "prime-agent" || host.version !== "0.9.4") {
    throw new Error("The source checks require the locked Prime Agent 0.9.4 type declarations.");
  }
  const python = (...args) => run("uv", ["run", "--locked", "--no-sync", "python", "-B", ...args]);
  python("scripts/check_skills.py");
  python("-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py");
  const poolTests = readdirSync(join(root, "components/pi-pool/tests")).filter((name) => /^test_.*\.py$/.test(name)).sort();
  if (poolTests.length === 0) throw new Error("No pool Python suites found.");
  for (const suite of poolTests) {
    python("-m", "unittest", "discover", "-s", "components/pi-pool/tests", "-p", suite);
  }
  python("-m", "unittest", "discover", "-s", "skills/linear-ticket/tests");
  const virevTests = readdirSync(join(root, "tests")).filter((name) => /^virev.*\.mjs$/.test(name)).sort();
  if (virevTests.length === 0) throw new Error("No Virev Node suites found.");
  run(process.execPath, ["--test", ...virevTests.map((name) => `tests/${name}`), "tests/agent-utilities.test.mjs"]);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.json"]);
  run("npm", ["test"], join(root, "components/daily-recap"));
  run("npm", ["test"], join(root, "components/user-history"));
  run("npm", ["run", "typecheck"], join(root, "components/user-history"));
  const poteto = join(root, "skills/poteto-mode/scripts");
  run(process.execPath, ["--test", "check-source-paths.test.mjs"], poteto);
  run("bun", ["test", "orch", "watch-pr"], poteto);
  run("bun", ["run", "typecheck"], poteto);
  const source = ["scripts", "tests", "components", "skills", "utils"].flatMap((name) => files(join(root, name))).sort();
  const pythonFiles = source.filter((path) => path.endsWith(".py"));
  pythonFiles.push(join(root, "components/pi-pool/bin/pi-pool"), join(root, "components/pi-pool/bin/pi-pool-token"));
  python("-c", "import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_bytes(), filename=p) for p in sys.argv[1:]]", ...pythonFiles);
  for (const path of source.filter((path) => /\.(mjs|js)$/.test(path))) run(process.execPath, ["--check", path]);
  run(process.execPath, ["--check", join(poteto, "watch-pr/watch-pr")]);
  for (const path of source.filter((path) => path.endsWith(".sh"))) run("bash", ["-n", path]);
  console.log("\nAll source checks passed. Live provider, Aside, and pool account access are separate checks.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
