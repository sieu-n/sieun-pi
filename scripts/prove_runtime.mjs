import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { lockedPrimeVersion } from "../utils/prime-version.mjs";

const { values } = parseArgs({ options: {
  home: { type: "string" }, cwd: { type: "string" },
  "prime-root": { type: "string" },
} });
assert(values.home && values.cwd, "Pass --home and --cwd for an installed isolated profile");
const home = realpathSync(values.home);
const cwd = realpathSync(values.cwd);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.HOME = home;
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(home, ".prime", "agent");
process.env.PI_CODING_AGENT_DIR = process.env.PRIME_AGENT_CODING_AGENT_DIR;
process.env.PI_POOL_DIR = join(home, ".config", "pi-pool");
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.GLOBAL_RULES_LOG = join(home, "global-rules-runtime-proof.log");
process.chdir(cwd);
const primeRoot = values["prime-root"] ? realpathSync(values["prime-root"])
  : dirname(dirname(fileURLToPath(import.meta.resolve("prime-agent"))));
const primePackage = JSON.parse(readFileSync(join(primeRoot, "package.json"), "utf8"));
assert.equal(primePackage.version, lockedPrimeVersion(fileURLToPath(new URL("..", import.meta.url))));
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(primeRoot, "dist", "index.js")).href);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
  settingsManager: SettingsManager.create(cwd, process.env.PRIME_AGENT_CODING_AGENT_DIR),
  bundledSkillsDir: null,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
const expectedSkills = JSON.parse(readFileSync(join(source, "install-manifest.json"), "utf8")).entries
  .filter(entry => entry.kind === "link" && entry.scope === "home" && entry.target.startsWith(".prime/agent/skills/"))
  .map(entry => join(source, entry.source, "SKILL.md"))
  .filter(path => existsSync(path))
  .map(path => realpathSync(path)).sort();
const aiEntry = execFileSync(process.execPath, ["--input-type=module", "-e",
  'process.stdout.write(import.meta.resolve("@earendil-works/pi-ai"))'],
  { cwd: primeRoot, encoding: "utf8" });
const { getModel, streamSimple } = await import(aiEntry);
const model = getModel("anthropic", "claude-fable-5");
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
  for (const command of ["virev-status", "virev-reload"]) assert.equal(commands.includes(command), false, `Removed /${command} must not load`);
  for (const command of ["what-did-i-say", "agent-chat"]) {
    assert.equal(commands.filter(name => name === command).length, 1, `Expected one /${command} after pass ${pass}`);
  }
  const extensionPaths = result.extensions.map(extension => realpathSync(extension.resolvedPath));
  assert(extensionPaths.includes(realpathSync(join(source, "components/user-history/extension/index.ts"))));
  const history = result.extensions.find(extension => realpathSync(extension.resolvedPath) === realpathSync(join(source, "components/user-history/extension/index.ts")));
  assert(history.flags.has("agent-chat-socket"), "Native history package must register --agent-chat-socket");
  for (const name of ["virev.ts", "global-rules.ts"]) {
    assert.equal(existsSync(join(cwd, ".prime/agent/extensions", name)), false, `No project-local ${name}`);
  }
  const rulesPath = realpathSync(join(source, "components/global-rules/index.ts"));
  assert(extensionPaths.includes(rulesPath));
  assert(!extensionPaths.some(path => path.includes("/components/virev/")), "The retired extension must not load");
  const rules = result.extensions.find(extension => realpathSync(extension.resolvedPath) === rulesPath);
  assert.deepEqual([...rules.handlers.keys()].sort(), ["tool_call"], "A clean load registers no failure notice");
  assert.deepEqual([...rules.tools.keys()], [], "global-rules adds no tool and no prompt text");
  const ctx = { cwd, hasUI: false };
  try {
    const registered = rules.handlers.get("tool_call");
    assert.equal(registered.length, 4, "Expected the guard, kernel-guard, transcript-guard and rlm-delete tool_call handlers");
    const handlers = { tool_call: async (event, context) => {
      for (const handler of registered) {
        const outcome = await handler(event, context);
        if (outcome !== undefined) return outcome;
      }
      return undefined;
    } };
    for (const where of [cwd, home]) {
      const blocked = await handlers.tool_call({ type: "tool_call", toolName: "ipython", toolCallId: "guard-proof",
        input: { code: 'bash("curl -sS -X POST https://acme.zendesk.com/api/v2/tickets/1.json -d x")' } }, { ...ctx, cwd: where });
      assert.equal(blocked?.block, true, "The send guard must refuse an outside send from every cwd");
    }
    const allowed = await handlers.tool_call({ type: "tool_call", toolName: "ipython", toolCallId: "read-proof",
      input: { code: 'bash("git status")' } }, ctx);
    assert.equal(allowed, undefined, "Loaded guard must allow a read-only command");
    const systemPrompt = "HOST PROMPT";
    const first = { role: "user", content: "Runtime proof.", timestamp: 1 };
    const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call-proof", name: "read_file", arguments: { path: "sample.txt" } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2 };
    const tool = { role: "toolResult", toolCallId: "call-proof", toolName: "read_file", content: [{ type: "text", text: "Sample text." }], isError: false, timestamp: 3 };
    const payload1 = await capture(systemPrompt, [first]);
    const payload2 = await capture(systemPrompt, [first, assistant, tool]);
    const payload3 = await capture(systemPrompt, [first, assistant, tool,
      { ...assistant, content: [{ type: "text", text: "Read complete." }], stopReason: "stop", timestamp: 4 },
      { role: "user", content: "Continue.", timestamp: 5 }]);
    assert.deepEqual(payload2.system, payload1.system);
    assert.deepEqual(payload3.system, payload1.system);
    assert.deepEqual(historicalMessages(payload2.messages.slice(0, payload1.messages.length)), historicalMessages(payload1.messages));
    assert.deepEqual(historicalMessages(payload3.messages.slice(0, payload2.messages.length)), historicalMessages(payload2.messages));
    report = { host: primePackage.name, version: primePackage.version, passes: pass,
      skills: actualSkills.length, extensionPaths, commands,
      checks: { retiredCommandsAbsent: true, guardBlocked: true, readAllowed: true,
        providerHistoryStable: true,
        providerNetworkCalls: fetchCalls, historyCommandsAndFlag: true },
      proof: "Native source discovery, guard handlers, Anthropic payload prefix equality, and repeated resource reload. No shell execution, model, account, or MCP calls." };
  } finally {
    for (const extension of result.extensions) {
      for (const shutdown of extension.handlers.get("session_shutdown") ?? []) {
        await shutdown({ type: "session_shutdown" }, {});
      }
    }
  }
}
console.log(JSON.stringify(report, null, 2));
