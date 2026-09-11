import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("..", import.meta.url));

function watchForLog(path, text, change) {
  const offset = readFileSync(path, "utf8").length;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unwatchFile(path, inspect);
      reject(new Error(`Log did not contain ${text}: ${readFileSync(path, "utf8").slice(offset)}`));
    }, 10000);
    function inspect() {
      if (!readFileSync(path, "utf8").slice(offset).includes(text)) return;
      clearTimeout(timeout);
      unwatchFile(path, inspect);
      resolve();
    }
    watchFile(path, { interval: 10 }, inspect);
    change();
  });
}

test("native global discovery, policy watcher, last-good load, and unrelated checkout", { timeout: 30000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "virev-native-"));
  const home = join(temp, "home");
  const agentDir = join(home, ".prime/agent");
  const component = join(temp, "source/components/virev");
  const project = join(temp, "protected");
  const unrelated = join(temp, "unrelated");
  const logPath = join(temp, "native.log");
  const projectsPath = join(agentDir, "virev-projects.json");
  cpSync(join(source, "components/virev"), component, { recursive: true });
  cpSync(join(source, "skills/unslop"), join(temp, "source/skills/unslop"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(unrelated, ".git"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const entry = join(agentDir, "extensions/virev.ts");
  symlinkSync(join(component, "extensions/virev.ts"), entry);
  const config = JSON.stringify({ projects: [{ root: project, policy: "auto-sns-agent" }] });
  writeFileSync(projectsPath, config);
  writeFileSync(logPath, "");
  const env = {
    HOME: home, PRIME_AGENT_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", VIREV_EXT_LOG: logPath, VIREV_PROJECTS_FILE: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let extensions = [];
  async function shutdown() {
    for (const extension of extensions) {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, {});
    }
    extensions = [];
  }
  t.after(async () => {
    await shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const primeRoot = join(source, "node_modules/prime-agent");
  assert.equal(JSON.parse(readFileSync(join(primeRoot, "package.json"), "utf8")).version, "0.9.4");
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(primeRoot, "dist/index.js")).href);
  const makeLoader = cwd => new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir),
    bundledSkillsDir: null, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  const loader = makeLoader(project);
  async function load(resourceLoader, cwd) {
    await resourceLoader.reload();
    const result = resourceLoader.getExtensions();
    assert.deepEqual(result.errors, []);
    extensions = result.extensions;
    assert.equal(extensions.length, 1, "one global entry, no project copy");
    const extension = extensions[0];
    assert.equal(realpathSync(extension.resolvedPath), realpathSync(entry));
    assert.deepEqual([...extension.commands.keys()], ["virev-reload"]);
    assert.equal(extension.commands.has("virev-status"), false);
    assert.equal(extension.handlers.has("context"), false, "history mutation must stay unregistered");
    const ctx = { cwd, hasUI: false };
    const handler = name => {
      const registered = extension.handlers.get(name) ?? [];
      assert.equal(registered.length, 1, `one ${name} handler`);
      return registered[0];
    };
    await handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
    return { handler, ctx };
  }
  const tool = { type: "tool_call", toolCallId: "native", toolName: "bash", input: { command: "git reset --hard" } };
  const { handler, ctx } = await load(loader, project);
  assert.equal((await handler("tool_call")(tool, ctx))?.block, true);
  const python = { ...tool, toolName: "ipython", input: { code: 'bash("git reset --hard")' } };
  assert.equal((await handler("tool_call")(python, ctx))?.block, true);
  assert.equal(await handler("tool_call")({ ...tool, input: { command: "git status" } }, ctx), undefined);
  const input = { type: "before_agent_start", systemPrompt: "NATIVE HOST" };
  const fullDoc = readFileSync(join(temp, "source/skills/unslop/SKILL.md"), "utf8").trim();
  const system = await handler("before_agent_start")(input, ctx);
  assert.ok(system.systemPrompt.includes(fullDoc));
  assert.equal(input.systemPrompt, "NATIVE HOST");
  assert.deepEqual(await handler("before_agent_start")(input, ctx), system);

  const policy = join(component, "policies/auto-sns-agent/index.mjs");
  const original = readFileSync(policy, "utf8");
  await watchForLog(logPath, "impl generation 2 live", () => {
    writeFileSync(policy, original.replace("virev git guard (bundled", "native-updated guard (bundled"));
  });
  assert.match((await handler("tool_call")(tool, ctx)).reason, /native-updated guard/);
  await watchForLog(logPath, "load failed", () => writeFileSync(policy, "invalid javascript !!!"));
  assert.match((await handler("tool_call")(tool, ctx)).reason, /native-updated guard/);
  await watchForLog(logPath, "impl generation 3 live", () => writeFileSync(policy, original));
  assert.match((await handler("tool_call")(tool, ctx)).reason, /virev git guard/);

  writeFileSync(projectsPath, '{"projects":[]}');
  assert.equal(await handler("tool_call")(tool, ctx), undefined, "config changes need no extension reload");
  writeFileSync(projectsPath, config);
  assert.equal((await handler("tool_call")(tool, ctx))?.block, true);
  await shutdown();
  const reloaded = await load(loader, project);
  assert.equal((await reloaded.handler("tool_call")(tool, reloaded.ctx))?.block, true);
  await shutdown();

  const other = await load(makeLoader(unrelated), unrelated);
  for (const command of ["git reset --hard", "npx convex dev --once", "pnpm test"]) {
    assert.equal(await other.handler("tool_call")({ ...tool, input: { command } }, other.ctx), undefined);
  }
  assert.ok((await other.handler("before_agent_start")(input, other.ctx)).systemPrompt.includes(fullDoc), "writing rules stay global");
});
