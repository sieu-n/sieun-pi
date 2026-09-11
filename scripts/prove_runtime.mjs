import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  home: { type: "string" }, project: { type: "string" },
  "prime-root": { type: "string" },
} });
assert(values.home && values.project, "Pass --home and --project for an installed isolated profile");
const home = realpathSync(values.home);
const project = realpathSync(values.project);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.HOME = home;
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(home, ".prime", "agent");
process.env.PI_CODING_AGENT_DIR = process.env.PRIME_AGENT_CODING_AGENT_DIR;
process.env.PI_POOL_DIR = join(home, ".config", "pi-pool");
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.VIREV_PROJECTS_FILE = join(home, ".prime", "agent", "virev-projects.json");
process.env.VIREV_EXT_LOG = join(home, "virev-runtime-proof.log");
process.chdir(project);
const primeRoot = values["prime-root"] ? realpathSync(values["prime-root"]) : join(source, "node_modules", "prime-agent");
const primePackage = JSON.parse(readFileSync(join(primeRoot, "package.json"), "utf8"));
assert.equal(primePackage.version, "0.9.4");
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(primeRoot, "dist", "index.js")).href);
const loader = new DefaultResourceLoader({
  cwd: project,
  agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
  settingsManager: SettingsManager.create(project, process.env.PRIME_AGENT_CODING_AGENT_DIR),
  bundledSkillsDir: null,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
const expectedSkills = readdirSync(join(source, "skills"))
  .map(name => join(source, "skills", name, "SKILL.md"))
  .filter(path => existsSync(path))
  .map(path => realpathSync(path)).sort();
const aiEntry = execFileSync(process.execPath, ["--input-type=module", "-e",
  'process.stdout.write(import.meta.resolve("@earendil-works/pi-ai"))'],
  { cwd: primeRoot, encoding: "utf8" });
const { getModel, streamSimple } = await import(aiEntry);
const model = getModel("anthropic", "claude-opus-5");
assert(model, "The native catalog must include the chosen serialization model");
const noNetwork = new Error("offline provider payload capture");
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("Network forbidden in runtime proof"); };
async function capture(systemPrompt, messages) {
  let payload;
  const result = await streamSimple(model, { systemPrompt, messages }, {
    apiKey: "sk-ant-oat-offline-proof", maxTokens: 128, reasoning: "off",
    onPayload(value) { payload = structuredClone(value); throw noNetwork; },
  }).result();
  assert(payload, "The native adapter must reach payload construction");
  assert.equal(result.stopReason, "error");
  assert.equal(fetchCalls, 0, "The proof must stop before any network call");
  return payload;
}
function withoutCacheMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheMarkers(item)]));
  }
  return value;
}
function historicalMessages(messages) {
  return withoutCacheMarkers(messages.map(message => ({ ...message,
    content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
  })));
}
let report;
for (let pass = 1; pass <= 2; pass++) {
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], "Native extension loader errors");
  const skills = loader.getSkills();
  assert.deepEqual(skills.diagnostics, [], "Native skill loader diagnostics");
  const actualSkills = skills.skills.map(skill => realpathSync(skill.filePath)).sort();
  assert.deepEqual(actualSkills, expectedSkills, "Native loader must discover every custom skill exactly once");
  const commands = result.extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.equal(commands.includes("virev-status"), false, "Removed status command must not load");
  for (const command of ["account", "virev-reload", "what-did-i-say", "agent-chat"]) {
    assert.equal(commands.filter(name => name === command).length, 1, `Expected one /${command} after pass ${pass}`);
  }
  const extensionPaths = result.extensions.map(extension => realpathSync(extension.resolvedPath));
  assert(extensionPaths.includes(realpathSync(join(source, "components/pi-pool/app/extension/index.ts"))));
  assert(extensionPaths.includes(realpathSync(join(source, "components/virev/extensions/virev.ts"))));
  assert(extensionPaths.includes(realpathSync(join(source, "components/user-history/extension/index.ts"))));
  const history = result.extensions.find(extension => realpathSync(extension.resolvedPath) === realpathSync(join(source, "components/user-history/extension/index.ts")));
  assert(history.flags.has("agent-chat-socket"), "Native history package must register --agent-chat-socket");
  assert.equal(existsSync(join(project, ".prime/agent/extensions/virev.ts")), false);
  assert.equal(existsSync(join(project, ".prime/agent/ext-impl/virev")), false);
  assert.equal(existsSync(join(project, ".prime/agent/virev-project.json")), false);
  const virevPath = realpathSync(join(source, "components/virev/extensions/virev.ts"));
  const virev = result.extensions.find(extension => realpathSync(extension.resolvedPath) === virevPath);
  assert(virev, "Native loader must discover Virev");
  const notifications = [];
  const ctx = { cwd: project, hasUI: true,
    ui: { notify: message => notifications.push(message), setStatus() {} } };
  try {
    const handlers = Object.fromEntries(["session_start", "tool_call", "before_agent_start"].map(name => {
      const registered = virev.handlers.get(name) ?? [];
      assert.equal(registered.length, 1, `Expected one Virev ${name} handler`);
      return [name, registered[0]];
    }));
    await handlers.session_start({ type: "session_start", reason: pass === 1 ? "startup" : "reload" }, ctx);
    assert.deepEqual(notifications, [], "Virev startup must not report errors");
    const blocked = await handlers.tool_call({ type: "tool_call", toolName: "ipython", toolCallId: "guard-proof",
      input: { code: 'bash("git reset --hard")' } }, ctx);
    assert.equal(blocked?.block, true, "Loaded guard must reject a destructive command without executing it");
    const allowed = await handlers.tool_call({ type: "tool_call", toolName: "ipython", toolCallId: "read-proof",
      input: { code: 'bash("git status")' } }, ctx);
    assert.equal(allowed, undefined, "Loaded guard must allow a read-only command");
    const outside = await handlers.tool_call({ type: "tool_call", toolName: "ipython", toolCallId: "unconfigured-proof",
      input: { code: 'bash("git reset --hard")' } }, { ...ctx, cwd: home });
    assert.equal(outside, undefined, "Auto-sns-agent policy must not apply to an unconfigured directory");
    assert.equal(virev.handlers.has("context"), false, "Virev must not rewrite outgoing history");
    const event = { type: "before_agent_start", systemPrompt: "HOST PROMPT" };
    const updated = await handlers.before_agent_start(event, ctx);
    const document = readFileSync(join(source, "skills/unslop/SKILL.md"), "utf8").trim();
    assert(updated?.systemPrompt.includes(document), "Loaded system instructions must include the bundled document");
    assert.deepEqual(await handlers.before_agent_start(event, ctx), updated, "System instructions must stay stable across turns");
    assert.equal(await handlers.before_agent_start({ ...event, systemPrompt: updated.systemPrompt }, ctx), undefined);
    const first = { role: "user", content: "Runtime proof.", timestamp: 1 };
    const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call-proof", name: "read_file", arguments: { path: "sample.txt" } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2 };
    const tool = { role: "toolResult", toolCallId: "call-proof", toolName: "read_file", content: [{ type: "text", text: "Sample text." }], isError: false, timestamp: 3 };
    const payload1 = await capture(updated.systemPrompt, [first]);
    const payload2 = await capture(updated.systemPrompt, [first, assistant, tool]);
    const payload3 = await capture(updated.systemPrompt, [first, assistant, tool,
      { ...assistant, content: [{ type: "text", text: "Read complete." }], stopReason: "stop", timestamp: 4 },
      { role: "user", content: "Continue.", timestamp: 5 }]);
    assert.deepEqual(payload2.system, payload1.system);
    assert.deepEqual(payload3.system, payload1.system);
    assert.deepEqual(historicalMessages(payload2.messages.slice(0, payload1.messages.length)), historicalMessages(payload1.messages));
    assert.deepEqual(historicalMessages(payload3.messages.slice(0, payload2.messages.length)), historicalMessages(payload2.messages));
    report = { host: primePackage.name, version: primePackage.version, passes: pass,
      skills: actualSkills.length, extensionPaths, commands,
      checks: { statusCommandAbsent: true, guardBlocked: true, readAllowed: true,
        fullRulesInSystem: true, contextHandlerAbsent: true, providerHistoryStable: true,
        providerNetworkCalls: fetchCalls, unrelatedProjectAllowed: true, historyCommandsAndFlag: true },
      proof: "Native source discovery, guard and stable system handlers, Anthropic payload prefix equality, and repeated resource reload. No shell execution, model, account, or MCP calls." };
  } finally {
    for (const extension of result.extensions) {
      for (const shutdown of extension.handlers.get("session_shutdown") ?? []) {
        await shutdown({ type: "session_shutdown" }, {});
      }
    }
  }
}
console.log(JSON.stringify(report, null, 2));
