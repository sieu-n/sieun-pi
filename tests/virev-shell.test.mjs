import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("../components/virev", import.meta.url));
const fullRules = fileURLToPath(new URL("../skills/unslop/SKILL.md", import.meta.url));

function watchForLog(path, text, change) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unwatchFile(path, inspect);
      reject(new Error(`Log did not contain ${text}: ${readFileSync(path, "utf8")}`));
    }, 5000);
    function inspect() {
      if (!readFileSync(path, "utf8").includes(text)) return;
      clearTimeout(timeout);
      unwatchFile(path, inspect);
      resolve();
    }
    // A new overlapping directory watcher can lose the source edit on macOS.
    watchFile(path, { interval: 10 }, inspect);
    change();
  });
}

test("installed source links load, hot swap, and reload without retained contexts", { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "virev-shell-"));
  const component = join(root, "source/components/virev");
  const project = join(root, "chosen-project");
  const entry = join(root, "home/.prime/agent/extensions/virev.ts");
  const projectsFile = join(root, "home/.prime/agent/virev-projects.json");
  const impl = join(component, "ext-impl/virev");
  const logPath = join(root, "virev.log");
  cpSync(source, component, { recursive: true });
  mkdirSync(join(root, "source/skills/unslop"), { recursive: true });
  copyFileSync(fullRules, join(root, "source/skills/unslop/SKILL.md"));
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(projectsFile, JSON.stringify({ projects: [{ root: project, policy: "auto-sns-agent" }] }));
  symlinkSync(join(component, "extensions/virev.ts"), entry);
  writeFileSync(logPath, "");
  const previousProjectsFile = process.env.VIREV_PROJECTS_FILE;
  process.env.VIREV_PROJECTS_FILE = projectsFile;
  const previousLog = process.env.VIREV_EXT_LOG;
  const previousAutoreload = process.env.VIREV_EXT_AUTORELOAD;
  process.env.VIREV_EXT_LOG = logPath;
  process.env.VIREV_EXT_AUTORELOAD = "1";
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  let reloadCount = 0;
  let contextValid = true;
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: { notify: (text) => notifications.push(text), setStatus() {} },
    reload: async () => {
      assert.equal(contextValid, true, "reload uses the current command context");
      reloadCount += 1;
      contextValid = false;
      await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
    },
  };
  t.after(async () => {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    if (previousProjectsFile === undefined) delete process.env.VIREV_PROJECTS_FILE;
    else process.env.VIREV_PROJECTS_FILE = previousProjectsFile;
    if (previousLog === undefined) delete process.env.VIREV_EXT_LOG;
    else process.env.VIREV_EXT_LOG = previousLog;
    if (previousAutoreload === undefined) delete process.env.VIREV_EXT_AUTORELOAD;
    else process.env.VIREV_EXT_AUTORELOAD = previousAutoreload;
    rmSync(root, { recursive: true, force: true });
  });
  const api = {
    on(name, handler) {
      assert.equal(handlers.has(name), false, `${name} is registered once`);
      handlers.set(name, handler);
    },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const { default: factory } = await import(pathToFileURL(entry).href);
  factory(api);
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "message_end", "session_shutdown", "session_start", "tool_call"]);
  const blockedEvent = { type: "tool_call", toolCallId: "guard", toolName: "bash", input: { command: "git reset --hard" } };
  assert.equal((await handlers.get("tool_call")(blockedEvent, ctx))?.block, true);
  const readEvent = { ...blockedEvent, input: { command: "git status" } };
  assert.equal(await handlers.get("tool_call")(readEvent, ctx), undefined);
  assert.equal(handlers.has("context"), false, "no request-time history mutator is registered");
  const promptEvent = { type: "before_agent_start", systemPrompt: "HOST" };
  const prompt = await handlers.get("before_agent_start")(promptEvent, ctx);
  assert.ok(prompt.systemPrompt.includes(readFileSync(fullRules, "utf8").trim()));
  assert.deepEqual(await handlers.get("before_agent_start")(promptEvent, ctx), prompt);
  assert.deepEqual([...commands.keys()], ["virev-reload"]);
  assert.equal(commands.has("virev-status"), false);
  assert.deepEqual(notifications, []);
  assert.ok(readFileSync(logPath, "utf8").includes(impl));
  assert.match(readFileSync(logPath, "utf8"), /impl generation 1 live \(startup\): v2 git-guard/);

  const indexPath = join(impl, "index.mjs");
  const originalIndex = readFileSync(indexPath, "utf8");
  await watchForLog(logPath, "v2-test git-guard", () => {
    writeFileSync(indexPath, originalIndex.replace('IMPL_VERSION = "v2"', 'IMPL_VERSION = "v2-test"'));
  });
  assert.match(readFileSync(logPath, "utf8"), /impl generation 2 live \(watch:[^)]+\): v2-test git-guard/);
  assert.equal(reloadCount, 0, "old auto-reload env flag cannot retain a command context");
  assert.equal((await handlers.get("tool_call")(blockedEvent, ctx))?.block, true);

  await watchForLog(logPath, "load failed", () => writeFileSync(indexPath, "invalid javascript !!!"));
  assert.equal((await handlers.get("tool_call")(blockedEvent, ctx))?.block, true, "bad edit keeps last working guard");
  writeFileSync(indexPath, originalIndex);
  await commands.get("virev-reload").handler("", ctx);
  assert.equal(reloadCount, 1);

  handlers.clear();
  commands.clear();
  contextValid = true;
  const reloadLogOffset = readFileSync(logPath, "utf8").length;
  factory(api);
  await handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
  assert.equal((await handlers.get("tool_call")(blockedEvent, ctx))?.block, true);
  assert.deepEqual([...commands.keys()], ["virev-reload"]);
  assert.deepEqual(notifications, []);
  assert.match(readFileSync(logPath, "utf8").slice(reloadLogOffset), /impl generation 1 live \(startup\): v2 git-guard/);
});
