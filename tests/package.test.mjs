import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("packed production install, native reload, update, rollback and uninstall", { timeout: 600_000 }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sieun-pi-package-")));
  try {
    const home = join(base, "home");
    const project = join(base, "project");
    mkdirSync(home);
    mkdirSync(project);
    const npmrc = join(base, "npmrc");
    writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
    const env = { ...process.env, HOME: home, NODE_PATH: "", npm_config_cache: join(base, "npm-cache"),
      npm_config_userconfig: npmrc, npm_config_globalconfig: join(base, "global-npmrc"),
      PRIME_AGENT_CODING_AGENT_DIR: join(home, ".prime/agent"), VIREV_PROJECTS_FILE: join(home, ".prime/agent/virev-projects.json") };
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", base], { env }))[0];
    const paths = packed.files.map(file => file.path);
    for (const path of paths) {
      assert(!/(^|\/)(node_modules|\.venv|__pycache__|\.git|\.work|\.test-artifacts|\.pytest_cache|\.cache|dist|sessions|memories)(\/|$)/.test(path), path);
      assert(!/(^|\/)(auth|models|credentials|state)\.json$/.test(path), path);
      assert(!/(^|\/)\.env(?:\.|$)/.test(path), path);
    }
    for (const path of ["scripts/cli.mjs", "scripts/manage.py", "install-manifest.json",
      "components/user-history/package.json", "components/user-history/SOURCE.md",
      "components/user-history/extension/index.ts", "components/user-history/src/page.ts",
      "components/virev/extensions/virev.ts", "skills/unslop/SKILL.md",
      "NOTICE", "LICENSES/pstack-MIT.txt", "LICENSES/tokenmaxxing-MIT.txt", "LICENSES/prime-agent-MIT.txt",
      "docs/attribution-pstack.json", "skills/poteto-mode/scripts/check-source-paths.test.mjs"]) assert(paths.includes(path), path);
    for (const path of ["skills/aside-browser/references/repl-api.md",
      "skills/linear-ticket/references/example-vir-371.md", "skills/linear-ticket/references/example-after-openapi.json",
      "skills/spec-report/references/approved-email-editor-spec.md"]) assert(!paths.includes(path), path);
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(metadata.private, undefined);
    assert(metadata.repository.url.includes("github.com/sieu-n/sieun-pi.git"));
    assert(metadata.dependencies["prime-agent"].startsWith("https://pub-"));
    assert.equal(metadata.dependencies.marked, "18.0.12");
    assert.equal(metadata.pi.extensions.length, 3);
    const tarball = join(base, packed.filename);
    const releases = [join(base, "release-a"), join(base, "release-b")];
    for (const prefix of releases) {
      run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], { env });
    }
    assert(!existsSync(join(home, ".prime")), "npm install must not mutate the profile");
    const roots = releases.map(prefix => join(prefix, "lib/node_modules/sieun-pi"));
    run(process.execPath, ["--test", join(roots[0], "skills/poteto-mode/scripts/check-source-paths.test.mjs")], { env, cwd: home });
    run(process.execPath, ["--input-type=module", "-e", 'const identity = await import("sieun-pi/agent-identity"); const context = await import("sieun-pi/prime-context"); const exporter = import.meta.resolve("sieun-pi/daily-recap/drifty_focus_export.py"); if (!exporter.endsWith("/components/daily-recap/drifty_focus_export.py") || typeof identity.detectAgentIdentity !== "function" || typeof context.derivePrimeAgent !== "function") process.exit(1);'], { env, cwd: roots[0] });
    const metadataHome = join(base, "metadata-home");
    const metadataAgent = join(metadataHome, ".prime/agent");
    mkdirSync(metadataAgent, { recursive: true });
    writeFileSync(join(metadataAgent, "settings.json"), JSON.stringify({ packages: [roots[0]] }));
    const metadataScript = join(base, "metadata-proof.mjs");
    writeFileSync(metadataScript, `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(process.argv[2]).href);
      const cwd = process.argv[3], agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir),
        bundledSkillsDir: null, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      try {
        await loader.reload();
        const result = loader.getExtensions();
        assert.deepEqual(result.errors, []);
        assert.equal(result.extensions.length, 3);
        const commands = result.extensions.flatMap(extension => [...extension.commands.keys()]);
        for (const name of ["account", "virev-reload", "what-did-i-say", "agent-chat"]) assert.equal(commands.filter(value => value === name).length, 1);
        assert(!commands.includes("virev-status"));
        assert.deepEqual(loader.getSkills().diagnostics, []);
        assert.equal(loader.getSkills().skills.length, 51);
      } finally {
        for (const extension of loader.getExtensions().extensions) for (const shutdown of extension.handlers.get("session_shutdown") ?? []) await shutdown({}, {});
      }
    `);
    run(process.execPath, [metadataScript, join(roots[0], "node_modules/prime-agent/dist/index.js"), project],
      { env: { ...env, HOME: metadataHome, PRIME_AGENT_CODING_AGENT_DIR: metadataAgent, VIREV_PROJECTS_FILE: join(metadataAgent, "virev-projects.json") } });
    const cli = (index, ...args) => JSON.parse(run(process.execPath, [join(roots[index], "scripts/cli.mjs"), ...args], { env }));
    assert.equal(run(join(releases[0], "bin/sieun-pi"), ["source"], { env }).trim(), roots[0]);
    const settings = join(home, ".prime/agent/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const originalSettings = '{ "packages": [], "custom": "preserve" }\n';
    writeFileSync(settings, originalSettings);
    const recap = cli(0, "daily-recap-setup", "--runtime", join(base, "recap"), "--plist", join(base, "recap.plist"));
    assert.equal(recap.mode, "dry-run");
    assert.equal(recap.services_loaded, false);
    assert(!existsSync(join(base, "recap")));
    const planA = join(base, "plan-a.json");
    cli(0, "plan", "--home", home, "--project", project, "--out", planA);
    const receiptA = cli(0, "apply", "--plan", planA).receipt;
    cli(0, "apply", "--plan", planA);
    cli(0, "verify", "--home", home, "--project", project);
    const proof = JSON.parse(run(process.execPath, [join(roots[0], "scripts/prove_runtime.mjs"), "--home", home,
      "--project", project], { env }));
    assert.equal(proof.passes, 2);
    for (const name of ["account", "virev-reload", "what-did-i-say", "agent-chat"]) {
      assert.equal(proof.commands.filter(command => command === name).length, 1, name);
    }
    assert(!proof.commands.includes("virev-status"));
    const next = join(base, "repeat.json");
    assert.equal(cli(0, "plan", "--home", home, "--project", project, "--out", next).changes, 0);
    const planB = join(base, "plan-b.json");
    cli(1, "plan", "--home", home, "--project", project, "--out", planB);
    const receiptB = cli(1, "apply", "--plan", planB).receipt;
    cli(1, "verify", "--home", home, "--project", project);
    cli(1, "rollback", "--receipt", receiptB);
    cli(0, "verify", "--home", home, "--project", project);
    cli(0, "uninstall", "--receipt", receiptA);
    assert.equal(readFileSync(settings, "utf8"), originalSettings);
    assert(!existsSync(join(home, ".prime/agent/extensions/user-history")));
    assert(!existsSync(join(home, ".prime/agent/extensions/virev.ts")));
    assert(!existsSync(join(project, ".prime")));
    process.stdout.write(`Packed ${paths.length} source files (${packed.unpackedSize} bytes); production dependency install and native commands passed.\n`);
  } finally {
    if (process.env.SIEUN_PI_KEEP_PACKAGE_TEST) process.stdout.write(`Package proof retained at ${base}\n`);
    else rmSync(base, { recursive: true, force: true });
  }
});
