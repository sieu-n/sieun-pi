import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "prime-agent";

const packageRoot = resolve(import.meta.dirname, "..");
const tools = ["chat_board", "correction_add", "ipython", "poteto_mode", "tell_owner"];

test("a chat reopens with its tools when the extension has no adjacent SDK package", async context => {
  const root = await mkdtemp(join(tmpdir(), "chat-tools-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "custom-agent");
  const extensionDir = join(root, "extension-package");
  for (const directory of ["extension", "src", "scripts"]) await cp(join(packageRoot, directory), join(extensionDir, directory), { recursive: true });
  await writeFile(join(extensionDir, "package.json"), '{"type":"module"}');
  await mkdir(join(extensionDir, "node_modules"));
  await symlink(join(packageRoot, "node_modules", "ws"), join(extensionDir, "node_modules", "ws"));
  await mkdir(join(agentDir, "skills", "poteto-mode"), { recursive: true });
  await writeFile(join(agentDir, "skills", "poteto-mode", "SKILL.md"), "# Poteto mode\n");
  const previousDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  const previousDepth = process.env.RLM_DEPTH;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
  process.env.RLM_DEPTH = "0";
  context.after(() => {
    if (previousDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR; else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousDir;
    if (previousDepth === undefined) delete process.env.RLM_DEPTH; else process.env.RLM_DEPTH = previousDepth;
  });
  const open = async (sessionManager: SessionManager, flagged: boolean) => {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      additionalExtensionPaths: [join(extensionDir, "extension", "index.ts")], noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, bundledSkillsDir: null });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    if (flagged) resourceLoader.getExtensions().runtime.flagValues.set("chat", true);
    const authStorage = AuthStorage.inMemory();
    const { session } = await createAgentSession({ cwd: root, agentDir, authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage), resourceLoader, sessionManager, settingsManager,
      rlmDepth: 0, prewarmIpythonKernel: false, includeGoals: false, includeCompactSkill: false });
    context.after(() => session.dispose());
    await session.bindExtensions({ shutdownHandler() {} });
    assert.deepEqual(session.getActiveToolNames().sort(), tools);
    return session;
  };
  const manager = SessionManager.create(root, join(root, "sessions"));
  const first = await open(manager, true);
  manager.appendMessage({ role: "user", content: "Remember this message.", timestamp: Date.now() });
  manager.flushNow();
  const file = manager.getSessionFile();
  assert(file);
  const saved = await readFile(file, "utf8");
  first.dispose();
  const restoredManager = SessionManager.open(file);
  const restored = await open(restoredManager, false);
  assert.equal(restored.sessionId, first.sessionId);
  assert.deepEqual(restoredManager.getEntries().slice(0, manager.getEntries().length), manager.getEntries());
  assert((await readFile(file, "utf8")).startsWith(saved));
  assert.equal(restoredManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "chat_mode").length, 1);
  const persona = restored.getToolDefinition("poteto_mode");
  assert(persona?.promptGuidelines?.some(line => line.includes(join(agentDir, "skills", "poteto-mode", "SKILL.md"))));
});
