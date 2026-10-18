import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { lockedPrimeVersion } from "../utils/prime-version.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));

test("Prime's own loader discovers the global link, reloads edited modules, and survives a broken module", { timeout: 30000 }, async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-native-")));
  const home = join(temp, "home");
  const agentDir = join(home, ".prime/agent");
  const component = join(temp, "source/components/global-rules");
  const project = join(temp, "project");
  const logPath = join(temp, "native.log");
  cpSync(join(source, "components/global-rules"), component, { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const entry = join(agentDir, "extensions/global-rules.ts");
  symlinkSync(join(component, "index.ts"), entry);
  writeFileSync(logPath, "");
  const env = {
    HOME: home, PRIME_AGENT_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", GLOBAL_RULES_LOG: logPath, GLOBAL_RULES_AUTO_SNS_AGENT: join(temp, "no-auto-sns-agent"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const primeRoot = join(source, "node_modules/prime-agent");
  assert.equal(JSON.parse(readFileSync(join(primeRoot, "package.json"), "utf8")).version, lockedPrimeVersion(source));
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(primeRoot, "dist/index.js")).href);
  const loader = new DefaultResourceLoader({
    cwd: project, agentDir, settingsManager: SettingsManager.create(project, agentDir),
    bundledSkillsDir: null, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  async function load() {
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.equal(realpathSync(extension.resolvedPath), realpathSync(entry));
    assert.deepEqual([...extension.commands.keys()], [], "native /reload replaces the old reload command");
    for (const name of ["context", "message_end"]) assert.equal(extension.handlers.has(name), false, name);
    return extension;
  }
  const ctx = { cwd: project, hasUI: false };
  const send = "curl -sS -X POST https://acme.zendesk.com/api/v2/tickets/1.json -d x";
  const blocked = { type: "tool_call", toolCallId: "native", toolName: "bash", input: { command: send } };

  let extension = await load();
  assert.deepEqual([...extension.handlers.keys()].sort(), ["tool_call"]);
  const toolCall = () => extension.handlers.get("tool_call")[0](blocked, ctx);
  assert.match((await toolCall()).reason, /^global-rules send guard/);
  const ipython = { ...blocked, toolName: "ipython", input: { code: `bash("${send}")` } };
  assert.equal((await extension.handlers.get("tool_call")[0](ipython, ctx))?.block, true);
  assert.equal(await extension.handlers.get("tool_call")[0]({ ...blocked, input: { command: "git status" } }, ctx), undefined);
  assert.deepEqual([...extension.tools.keys()], [], "global-rules adds no tool and no prompt text");

  const sendGuard = join(component, "send-guard.ts");
  const original = readFileSync(sendGuard, "utf8");
  writeFileSync(sendGuard, original.replace("global-rules send guard:", "edited send guard:"));
  extension = await load();
  assert.match((await toolCall()).reason, /^edited send guard/, "a reload re-reads nested modules");

  writeFileSync(sendGuard, "invalid javascript !!!");
  extension = await load();
  assert.equal(extension.handlers.get("tool_call").length, 2, "only kernel-guard.ts and rlm-delete.ts stay registered");
  assert.equal(await toolCall(), undefined);
  const notes = [];
  await extension.handlers.get("session_start")[0]({ type: "session_start", reason: "reload" }, { hasUI: true, ui: { notify: (text) => notes.push(text) } });
  assert.match(notes[0], /could not load guard\.ts/);
  assert.match(readFileSync(logPath, "utf8"), /\[load\] guard\.ts failed/);

  writeFileSync(sendGuard, original);
  extension = await load();
  assert.match((await toolCall()).reason, /^global-rules send guard/);
});
