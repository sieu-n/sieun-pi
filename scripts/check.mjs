import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { lockedPrimeVersion } from "../legacy/prime/utils/prime-version.mjs";

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
  requireFile("legacy/prime/user-history/node_modules/tsx/dist/cli.mjs", "npm ci --ignore-scripts --prefix legacy/prime/user-history");
  requireFile("skills/poteto-mode/scripts/node_modules/typescript/bin/tsc", "cd skills/poteto-mode/scripts && bun install --frozen-lockfile");
  const host = JSON.parse(readFileSync(join(root, "node_modules/prime-agent/package.json"), "utf8"));
  const locked = lockedPrimeVersion(root);
  if (host.name !== "prime-agent" || host.version !== locked) {
    throw new Error(`The source checks require the locked Prime Agent ${locked} type declarations. Run npm ci --ignore-scripts.`);
  }
  const python = (...args) => run("uv", ["run", "--locked", "--no-sync", "python", "-B", ...args]);
  python("scripts/check_skills.py");
  python("-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py");
  const poolTests = readdirSync(join(root, "packages/pi-pool/test")).filter((name) => /^test_.*\.py$/.test(name)).sort();
  if (poolTests.length === 0) throw new Error("No pool Python suites found.");
  for (const suite of poolTests) {
    python("-m", "unittest", "discover", "-s", "packages/pi-pool/test", "-p", suite);
  }
  python("-m", "unittest", "discover", "-s", "skills/linear-ticket/tests");
  python("-m", "unittest", "discover", "-s", "skills/aside-browser/tests");
  python("-m", "unittest", "discover", "-s", "legacy/prime/usage-feed/tests");
  python("-m", "unittest", "discover", "-s", "legacy/prime/tests", "-p", "test_*.py");
  python("-m", "unittest", "discover", "-s", "legacy/prime/daemon-keeper/tests");
  const rulesTests = readdirSync(join(root, "tests")).filter((name) => /^global-rules-.*\.test\.mjs$/.test(name)).sort();
  if (rulesTests.length === 0) throw new Error("No global-rules Node suites found.");
  run(process.execPath, ["--test", ...rulesTests.map((name) => `tests/${name}`), "packages/pi-claude-rules/test/rules.test.mjs", "legacy/prime/rules/unit-env-prime-shutdown.test.mjs", "tests/agent-utilities.test.mjs", "tests/git-stale-index.test.mjs", "tests/git-mass-delete.test.mjs", "tests/git-escaped-newline.test.mjs", "tests/release-chat.test.mjs", "tests/desktop-config.test.mjs"]);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.json"]);
  // Prime drops an extension that throws at load with no log, so a box with Prime installed loads each configured one through it (10-27 23:37Z).
  const primeBin = process.env.PRIME_AGENT_REAL_BIN ?? join(process.env.HOME ?? "", ".local/share/prime-agent/bin/prime-agent");
  if (existsSync(primeBin) && existsSync(join(process.env.HOME ?? "", ".prime/agent/extensions"))) run(process.execPath, ["scripts/check-extension-tools.mjs"]);
  else console.log("\nSkipped scripts/check-extension-tools.mjs: this box has no prime-agent binary or ~/.prime/agent/extensions.");
  run("npm", ["test"], join(root, "legacy/prime/user-history"));
  run("npm", ["run", "typecheck"], join(root, "legacy/prime/user-history"));
  const poteto = join(root, "skills/poteto-mode/scripts");
  run(process.execPath, ["--test", "check-source-paths.test.mjs"], poteto);
  run("bun", ["test", "orch", "watch-pr"], poteto);
  run("bun", ["run", "typecheck"], poteto);
  const source = ["scripts", "tests", "components", "packages", "legacy", "skills", "utils"].flatMap((name) => files(join(root, name))).sort();
  const pythonFiles = source.filter((path) => path.endsWith(".py"));
  pythonFiles.push(join(root, "packages/pi-pool/bin/pi-pool"), join(root, "packages/pi-pool/bin/pi-pool-token"));
  python("-c", "import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_bytes(), filename=p) for p in sys.argv[1:]]", ...pythonFiles);
  for (const path of source.filter((path) => /\.(mjs|js)$/.test(path))) run(process.execPath, ["--check", path]);
  run(process.execPath, ["--check", join(poteto, "watch-pr/watch-pr")]);
  for (const path of source.filter((path) => path.endsWith(".sh"))) run("bash", ["-n", path]);
  console.log("\nAll source checks passed. Live provider, Aside, and pool account access are separate checks.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
