import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DaemonClient, SessionManager } from "prime-agent";
import { createChatBackend, type ChatBackend, type ChatModel, type ChatView } from "../src/chat-backend.ts";
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES, type ChatImage } from "../src/chat-images.ts";
import { chatNativeProviderSource, startChatNativeCli, stopChatNativeDaemon, waitForChatNativeFile } from "./chat-native-fixture.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const primeRoot = resolve(dirname(fileURLToPath(import.meta.resolve("prime-agent"))), "..");
const node = process.execPath;
const cli = join(primeRoot, "dist/bundle/cli.js");
const textModel = { provider: "chat-native-test", id: "synthetic", name: "Deterministic native chat fixture",
  contextWindow: 1000000, input: ["text"] } satisfies ChatModel;
const visionModel = { provider: "chat-native-test", id: "synthetic-vision", name: "Deterministic native vision fixture",
  contextWindow: 2000000, input: ["text", "image"] } satisfies ChatModel;
const imageFixtures = [
  { type: "image", mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=" },
  { type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
] satisfies ChatImage[];

function assertSessionUsage(view: ChatView, calls: number): void {
  assert.equal(view.usage.kind, "native-session");
  assert(view.usage.kind === "native-session");
  assert.equal(view.usage.inputTokens, calls * 150, "native input total includes cache reads and writes");
  assert.equal(view.usage.outputTokens, calls * 25);
  assert(Math.abs(view.usage.cost - calls * 0.00364) < 1e-12);
  assert.equal(view.usage.providerLimits, "unavailable", "session usage is not provider quota");
  assert(view.usage.context);
  assert.equal(view.usage.context.contextWindow, visionModel.contextWindow);
  assert(typeof view.usage.context.tokens === "number" && view.usage.context.tokens > 0);
  assert.equal(view.usage.context.percent, view.usage.context.tokens / visionModel.contextWindow * 100);
}

function providerStarts(text: string) {
  return text.trim().split("\n").flatMap(line => {
    const value: unknown = JSON.parse(line);
    assert(typeof value === "object" && value !== null && "stage" in value);
    if (value.stage !== "start") return [];
    assert("message" in value && typeof value.message === "string");
    assert("model" in value && typeof value.model === "string");
    assert("provider" in value && typeof value.provider === "string");
    assert("pid" in value && typeof value.pid === "number");
    assert("content" in value);
    return [{ message: value.message, model: value.model, provider: value.provider, pid: value.pid, content: value.content }];
  });
}

type NativeRow = { sessionId: string; activeSessionId?: string; workerPid?: number; workerState?: string };
async function nativeRows(daemon: DaemonClient): Promise<NativeRow[]> {
  const response = await daemon.request({ type: "list", all: true, includeClientOwned: true }, 30000);
  assert(response.success, JSON.stringify(response));
  const data = response.data;
  assert(typeof data === "object" && data !== null && "sessions" in data && Array.isArray(data.sessions));
  return data.sessions.map((row: unknown): NativeRow => {
    assert(typeof row === "object" && row !== null && "sessionId" in row && typeof row.sessionId === "string");
    return { sessionId: row.sessionId,
      ...("activeSessionId" in row && typeof row.activeSessionId === "string" ? { activeSessionId: row.activeSessionId } : {}),
      ...("workerPid" in row && typeof row.workerPid === "number" ? { workerPid: row.workerPid } : {}),
      ...("workerState" in row && typeof row.workerState === "string" ? { workerState: row.workerState } : {}) };
  }).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function seedSession(cwd: string, sessions: string, name: string) {
  const previousDepth = process.env.RLM_DEPTH;
  process.env.RLM_DEPTH = "0";
  const manager = SessionManager.create(cwd, sessions);
  if (previousDepth === undefined) delete process.env.RLM_DEPTH;
  else process.env.RLM_DEPTH = previousDepth;
  manager.appendSessionInfo(name);
  manager.appendModelChange("chat-native-test", "synthetic");
  manager.appendMessage({ role: "user", content: `SAVED QUESTION ${name}`, timestamp: 1000 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `SAVED ANSWER ${name}` }],
    api: "chat-native-test-api", provider: "chat-native-test", model: "synthetic", stopReason: "stop", timestamp: 1001,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.flushNow();
  const sessionFile = manager.getSessionFile();
  assert(sessionFile);
  return { sessionId: manager.getSessionId(), sessionFile, name };
}

test("native chat targets sessions, changes models, reports usage, sends images, and preserves workers", { timeout: process.env.CHAT_TEST_BROWSER === "1" ? 480000 : 120000 }, async () => {
  const id = randomBytes(6).toString("hex");
  const root = join(packageRoot, ".test-artifacts", `chat-native-${id}`);
  const home = join(root, "home");
  const config = join(home, ".prime/agent");
  const cwd = join(root, "project");
  const sessions = join(root, "sessions");
  const socket = `/tmp/wc-${id}.sock`;
  const temporary = `/tmp/wct-${id}`;
  await Promise.all([home, config, cwd, sessions, temporary].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(config, "settings.json"), JSON.stringify({ onboardingShown: true, onboardingCompleted: true,
    telemetry: { enabled: false, noticeShown: true }, compaction: { enabled: false }, retry: { enabled: false },
    mcpServers: {}, packages: [], extensions: [], skills: [] }));
  const env = { HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: "en_US.UTF-8", TERM: "dumb",
    PRIME_AGENT_CODING_AGENT_DIR: config, PRIME_AGENT_SESSION_DIR: sessions, PRIME_AGENT_TELEMETRY: "0", PI_OFFLINE: "1" };
  const alpha = seedSession(cwd, sessions, `chat-alpha-${id}`);
  const beta = seedSession(cwd, sessions, `chat-beta-${id}`);
  const saved = seedSession(cwd, sessions, `chat-saved-${id}`);
  const savedManager = SessionManager.open(saved.sessionFile, sessions);
  const png = imageFixtures[0];
  assert(png);
  const oversizedBytes = Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1);
  Buffer.from(png.data, "base64").copy(oversizedBytes);
  const omittedImageIds = [
    { ...png, mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") },
    { ...png, data: "invalid-base64" },
    { ...png, data: oversizedBytes.toString("base64") },
  ].map(image => savedManager.appendMessage({ role: "user", content: [image], timestamp: 1002 }));
  const partlyOmittedImageId = savedManager.appendMessage({ role: "user", timestamp: 1003,
    content: Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => png) });
  savedManager.flushNow();
  const savedBytes = await readFile(saved.sessionFile);
  const calls = join(root, "provider-calls.jsonl");
  const gate = join(root, "release-provider");
  const provider = join(root, "provider.mjs");
  const extension = join(root, "extension.ts");
  const aside = join(root, "aside-test.mjs");
  const asideUrl = join(root, "aside-url.json");
  await writeFile(aside, `#!${node}
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const [flag, bundle, url] = process.argv.slice(2);
assert.equal(flag, '-b');
assert.equal(bundle, 'at.studio.AsideBrowser');
assert.equal(new URL(url).hostname, '127.0.0.1');
await writeFile(${JSON.stringify(asideUrl)}, JSON.stringify({ url }));
`, { mode: 0o700 });
  await writeFile(extension, `import historyExtension from ${JSON.stringify(join(packageRoot, "extension/index.ts"))};
import provider from ${JSON.stringify(provider)};
export default function(pi) { historyExtension(pi, ${JSON.stringify(aside)}); provider(pi); }
`);
  await writeFile(calls, "");
  await writeFile(provider, chatNativeProviderSource({ calls, gate,
    aiModule: fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")) }));
  const native = startChatNativeCli({ node, cwd, env,
    args: [cli, "--mode", "rpc", "--daemon-socket", socket, "--agent-chat-socket", socket, "--cwd", cwd, "--no-extensions", "-e", extension,
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools", "--no-themes",
      "--provider", "chat-native-test", "--model", "synthetic", "--no-session"] });
  const daemon = new DaemonClient(socket);
  let backend: ChatBackend | undefined;
  let supervisorPid: number | undefined;
  try {
    await native.rpc("get_state");
    await daemon.connect();
    supervisorPid = (await daemon.waitForHello()).supervisorPid;
    assert(supervisorPid && supervisorPid !== native.child.pid);
    for (const target of [alpha, beta]) {
      const created = await daemon.request({ type: "create", sessionPath: target.sessionFile, launchEnv: env,
        config: { cwd, agentDir: config, sessionDir: sessions, provider: "chat-native-test", model: "synthetic",
          noExtensions: true, extensions: [extension], noSkills: true, noPromptTemplates: true, noContextFiles: true,
          noTools: true, noThemes: true, telemetryDisabled: true,
          extensionFlagValues: { "agent-chat-socket": socket } } }, 30000);
      assert(created.success, JSON.stringify(created));
    }
    backend = await createChatBackend({ socketPath: socket });
    const listed = await backend.list();
    await writeFile(join(root, "initial-catalog.json"), JSON.stringify(listed, null, 2));
    assert.deepEqual(listed.map(row => row.sessionId).sort(), [alpha.sessionId, beta.sessionId, saved.sessionId].sort(), "isolated catalog contains only owned sessions");
    for (const target of [alpha, beta]) {
      const row = listed.find(item => item.sessionId === target.sessionId);
      assert(row);
      assert.equal(row.kind, "root");
      assert.equal(row.name, target.name);
      assert.equal(row.cwd, cwd);
      assert.equal(row.canSend, true);
    }
    const before = await nativeRows(daemon);
    const alphaNative = before.find(row => row.sessionId === alpha.sessionId);
    const betaNative = before.find(row => row.sessionId === beta.sessionId);
    assert(alphaNative?.activeSessionId && alphaNative.workerPid);
    assert(betaNative?.activeSessionId && betaNative.workerPid);
    assert.notEqual(alphaNative.workerPid, betaNative.workerPid);
    const betaBefore = await backend.read(beta.sessionId);
    assert.deepEqual(betaBefore.messages.map(message => message.text), [`SAVED QUESTION ${beta.name}`, `SAVED ANSWER ${beta.name}`]);
    const alphaBefore = await backend.read(alpha.sessionId);
    assert.deepEqual(alphaBefore.messages.map(message => message.text), [`SAVED QUESTION ${alpha.name}`, `SAVED ANSWER ${alpha.name}`]);
    assert.deepEqual((await backend.read(beta.sessionId)).messages, betaBefore.messages, "switching reads keeps targets independent");
    const savedView = await backend.read(saved.sessionId);
    assert.equal(savedView.session.status, "saved");
    assert.equal(savedView.session.canSend, false);
    for (const entryId of omittedImageIds) {
      const message = savedView.messages.find(item => item.id === entryId);
      assert(message, "an image-only saved user entry remains visible when its image cannot be previewed");
      assert.equal(message.text, "[Saved image]");
      assert.deepEqual(message.images, []);
    }
    const partlyOmitted = savedView.messages.find(item => item.id === partlyOmittedImageId);
    assert(partlyOmitted);
    assert.equal(partlyOmitted.text, "[Saved image]", "images over the preview count keep a placeholder");
    assert.equal(partlyOmitted.images.length, MAX_CHAT_IMAGES, "the preview limit is unchanged");
    assert.equal(savedView.messages.length, 2 + omittedImageIds.length + 1);
    assert.deepEqual(savedView.controls, { kind: "saved", currentModel: null, canChangeModel: false });
    assert.deepEqual(savedView.usage, { kind: "unavailable", reason: "not-recorded", context: null,
      providerLimits: "unavailable" });
    assert.deepEqual(alphaBefore.controls, { kind: "live", currentModel: textModel, canChangeModel: true });
    assert.equal(alphaBefore.usage.kind, "unavailable", "missing native usage is not shown as zero");
    assert(!("inputTokens" in alphaBefore.usage));
    assert.equal(alphaBefore.usage.providerLimits, "unavailable");
    assert.deepEqual(await readFile(saved.sessionFile), savedBytes, "saved read preserves exact file bytes");
    assert.deepEqual(await nativeRows(daemon), before, "saved read creates or wakes no worker");
    await assert.rejects(backend.read(`unknown-${id}`), /catalog/);
    await assert.rejects(backend.send({ sessionId: `unknown-${id}`, message: "must not route" }), /catalog/);
    await assert.rejects(backend.send({ sessionId: saved.sessionId, message: "must not wake" }), /Resume/);
    await assert.rejects(backend.send({ sessionId: alpha.sessionId, message: "  " }), /message/);
    await assert.rejects(backend.models(`unknown-${id}`), /catalog/);
    await assert.rejects(backend.models(saved.sessionId), /Resume/);
    await assert.rejects(backend.setModel({ sessionId: saved.sessionId, provider: visionModel.provider,
      modelId: visionModel.id }), /Resume/);
    await assert.rejects(backend.setModel({ sessionId: `unknown-${id}`, provider: visionModel.provider,
      modelId: visionModel.id }), /catalog/);
    await assert.rejects(backend.setModel({ sessionId: alpha.sessionId, provider: " ", modelId: visionModel.id }), /provider|model/i);
    await assert.rejects(backend.setModel({ sessionId: alpha.sessionId, provider: visionModel.provider, modelId: " " }), /provider|model/i);
    const modelCatalog = await backend.models(alpha.sessionId);
    assert.equal(modelCatalog.sessionId, alpha.sessionId);
    assert(modelCatalog.configuredProviders.includes(textModel.provider));
    assert.deepEqual(modelCatalog.models.filter(model => model.provider === textModel.provider), [textModel, visionModel]);
    assert.deepEqual((await backend.models(beta.sessionId)).models, modelCatalog.models);
    const unconfigured = modelCatalog.models.find(model => !modelCatalog.configuredProviders.includes(model.provider));
    assert(unconfigured, "isolated native catalog includes a provider with no credentials");
    await assert.rejects(backend.setModel({ sessionId: alpha.sessionId, provider: textModel.provider,
      modelId: `missing-${id}` }), /Model not found/);
    await assert.rejects(backend.setModel({ sessionId: alpha.sessionId, provider: unconfigured.provider,
      modelId: unconfigured.id }), /Model not found|No API key|not available/);
    assert.deepEqual((await backend.read(alpha.sessionId)).controls.currentModel, textModel,
      "invalid and unconfigured selections leave the current model unchanged");
    const alphaBeforeImageRejection = await readFile(alpha.sessionFile);
    await assert.rejects(backend.send({ sessionId: alpha.sessionId, message: "", images: imageFixtures }), /image|vision/i);
    assert.deepEqual(await readFile(alpha.sessionFile), alphaBeforeImageRejection, "text-only rejection persists no user prompt");
    for (const model of [visionModel, textModel, visionModel]) {
      assert.deepEqual(await backend.setModel({ sessionId: alpha.sessionId, provider: model.provider, modelId: model.id }), model);
      const selected = await backend.read(alpha.sessionId);
      assert.deepEqual(selected.controls, { kind: "live", currentModel: model, canChangeModel: true },
        "the latest completed native selection is visible");
      assert.equal(selected.session.model, `${model.provider}/${model.id}`);
      assert.deepEqual((await backend.read(beta.sessionId)).controls.currentModel, textModel,
        "model changes affect only the selected live session");
    }
    const modelEntries = SessionManager.open(alpha.sessionFile, sessions).getEntries().filter(entry => entry.type === "model_change");
    assert.deepEqual(modelEntries.slice(-3).map(entry => ({ provider: entry.provider, modelId: entry.modelId })),
      [visionModel, textModel, visionModel].map(model => ({ provider: model.provider, modelId: model.id })),
      "the native session persists model selection order");
    assert.deepEqual(await readFile(saved.sessionFile), savedBytes, "saved model methods preserve exact file bytes");
    assert.deepEqual(await nativeRows(daemon), before, "model methods create or replace no workers");
    assert.equal(await readFile(calls, "utf8"), "", "read/list/model/rejection paths make no model calls");

    const prompt = `ONLY ALPHA ${id} [hold]`;
    const followUp = `QUEUED FOLLOW UP ${id}`;
    await backend.send({ sessionId: alpha.sessionId, message: prompt });
    await waitForChatNativeFile(calls, text => text.includes('"stage":"held"'));
    const streaming = await backend.read(alpha.sessionId);
    assert.equal(streaming.session.status, "running");
    assert.deepEqual(streaming.controls, { kind: "live", currentModel: visionModel, canChangeModel: false });
    await assert.rejects(backend.setModel({ sessionId: alpha.sessionId, provider: textModel.provider,
      modelId: textModel.id }), /finish|busy/i);
    assert.deepEqual((await backend.read(alpha.sessionId)).controls.currentModel, visionModel);
    assert(streaming.messages.some(message => message.role === "user" && message.text === prompt));
    assert(streaming.messages.some(message => message.role === "assistant" && message.streaming && message.text === "SYNTHETIC REPLY: "));
    await backend.send({ sessionId: alpha.sessionId, message: followUp, images: imageFixtures });
    const queued = await backend.read(alpha.sessionId);
    assert.equal(queued.queueCount, 1, "busy input is admitted to the follow-up queue");
    assert.equal(queued.session.status, "running");
    assert.equal(queued.controls.canChangeModel, false);
    await assert.rejects(backend.setModel({ sessionId: alpha.sessionId, provider: textModel.provider,
      modelId: textModel.id }), /finish|busy/i);
    const nativeQueue = await daemon.request({ type: "get_queue", activeSessionId: alphaNative.activeSessionId });
    assert(nativeQueue.success, JSON.stringify(nativeQueue));
    await writeFile(join(root, "queued-state.json"), JSON.stringify({ view: queued, native: nativeQueue }, null, 2));
    const queue = nativeQueue.data;
    assert(typeof queue === "object" && queue !== null && "steering" in queue && "followUp" in queue);
    assert.deepEqual(queue.steering, [], "busy send is not steering");
    assert.deepEqual(queue.followUp, [followUp]);
    assert.deepEqual((await backend.read(beta.sessionId)).messages, betaBefore.messages, "other live session receives nothing");
    const heldCalls = await readFile(calls, "utf8");
    assert.doesNotMatch(heldCalls, /"stage":"(?:aborted|error|done)"/);
    assert.equal(heldCalls.split('"stage":"start"').length - 1, 1, "queued prompt has not interrupted or started a second call");
    await writeFile(gate, "release");
    await waitForChatNativeFile(calls, text => text.includes(JSON.stringify({ stage: "done", message: followUp }).slice(0, -1)));
    const idle = await daemon.request({ type: "wait_for_idle", activeSessionId: alphaNative.activeSessionId }, 30000);
    assert(idle.success, JSON.stringify(idle));
    const completed = await backend.read(alpha.sessionId);
    assert.equal(completed.queueCount, 0);
    assert.deepEqual(completed.messages.map(message => message.text), [
      `SAVED QUESTION ${alpha.name}`, `SAVED ANSWER ${alpha.name}`, prompt, `SYNTHETIC REPLY: ${prompt}`,
      followUp, `SYNTHETIC REPLY: ${followUp}`,
    ]);
    assert(completed.messages.every(message => !message.streaming));
    assert.deepEqual(completed.controls, { kind: "live", currentModel: visionModel, canChangeModel: true });
    assertSessionUsage(completed, 2);
    assert.deepEqual(completed.messages.find(message => message.text === followUp)?.images, imageFixtures,
      "the renderer receives native user images after a queued text-and-image prompt");
    const entries = SessionManager.open(alpha.sessionFile, sessions).getEntries();
    const persistedUsers = entries.flatMap(entry => entry.type === "message" && entry.message.role === "user"
      ? [typeof entry.message.content === "string" ? entry.message.content
        : entry.message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")] : []);
    assert(persistedUsers.includes(prompt), "send persists an ordinary user prompt");
    assert(persistedUsers.includes(followUp));
    assert.deepEqual((await backend.read(beta.sessionId)).messages, betaBefore.messages);
    assert.deepEqual(await readFile(saved.sessionFile), savedBytes);
    const queuedCalls = providerStarts(await readFile(calls, "utf8"));
    assert.equal(queuedCalls.length, 2);
    assert.deepEqual(queuedCalls[1]?.content, [{ type: "text", text: followUp }, ...imageFixtures],
      "native queued provider payload preserves text first, then image order and bytes");
    await backend.send({ sessionId: alpha.sessionId, message: "", images: imageFixtures });
    await waitForChatNativeFile(calls, text => text.includes('"stage":"done","message":""'));
    const imageIdle = await daemon.request({ type: "wait_for_idle", activeSessionId: alphaNative.activeSessionId }, 30000);
    assert(imageIdle.success, JSON.stringify(imageIdle));
    const withImages = await backend.read(alpha.sessionId);
    assert.equal(withImages.messages.length, completed.messages.length + 2);
    const imageOnlyUser = withImages.messages.at(-2);
    assert(imageOnlyUser);
    assert.equal(imageOnlyUser.role, "user");
    assert.equal(imageOnlyUser.text, "", "an image-only prompt is not replaced with a saved-image label");
    assert.deepEqual(imageOnlyUser.images, imageFixtures);
    assert.equal(imageOnlyUser.streaming, false);
    assert.equal(withImages.messages.at(-1)?.text, "SYNTHETIC REPLY: ");
    assert.deepEqual(withImages.messages.at(-1)?.images, [], "assistant messages have no user image attachments");
    assertSessionUsage(withImages, 3);
    const nativeImageUsers = SessionManager.open(alpha.sessionFile, sessions).getEntries().flatMap(entry =>
      entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content)
        ? [entry.message.content] : []);
    assert.deepEqual(nativeImageUsers.slice(-2), [
      [{ type: "text", text: followUp }, ...imageFixtures], [{ type: "text", text: "" }, ...imageFixtures],
    ], "image bytes persist in ordinary native user messages without attachment wrappers");
    const finalCalls = await readFile(calls, "utf8");
    assert.doesNotMatch(finalCalls, /"stage":"(?:aborted|error)"/);
    const starts = providerStarts(finalCalls);
    assert.equal(starts.length, 3);
    assert.deepEqual(starts.map(call => call.message), [prompt, followUp, ""]);
    assert.deepEqual(starts[2]?.content, [{ type: "text", text: "" }, ...imageFixtures]);
    assert(starts.every(call => call.provider === visionModel.provider && call.model === visionModel.id && call.pid === alphaNative.workerPid),
      "all prompts use only the selected native worker and its latest model");
    assert.deepEqual((await backend.read(beta.sessionId)).messages, betaBefore.messages);
    assert.equal((await backend.read(beta.sessionId)).usage.kind, "unavailable", "other live usage remains unchanged");
    const replacement = seedSession(cwd, sessions, `chat-replacement-${id}`);
    const switched = await daemon.request({ type: "switch_session", activeSessionId: betaNative.activeSessionId,
      sessionPath: replacement.sessionFile }, 30000);
    assert(switched.success, JSON.stringify(switched));
    await assert.rejects(backend.send({ sessionId: beta.sessionId, message: "STALE BROWSER TARGET" }), /Resume|changed|catalog/);
    await assert.rejects(backend.models(beta.sessionId), /Resume|changed|catalog/);
    await assert.rejects(backend.setModel({ sessionId: beta.sessionId, provider: visionModel.provider,
      modelId: visionModel.id }), /Resume|changed|catalog/);
    const replacementView = await backend.read(replacement.sessionId);
    assert.deepEqual(replacementView.messages.map(message => message.text), [
      `SAVED QUESTION ${replacement.name}`, `SAVED ANSWER ${replacement.name}`,
    ], "a completed terminal switch never redirects a stale browser prompt to the replacement");
    assert.equal(await readFile(calls, "utf8"), finalCalls);
    const replacementNative = (await nativeRows(daemon)).find(row => row.sessionId === replacement.sessionId);
    assert(replacementNative?.activeSessionId);
    const restored = await daemon.request({ type: "switch_session", activeSessionId: replacementNative.activeSessionId,
      sessionPath: beta.sessionFile }, 30000);
    assert(restored.success, JSON.stringify(restored));
    const commands = await daemon.request({ type: "get_commands", activeSessionId: alphaNative.activeSessionId });
    assert(commands.success, JSON.stringify(commands));
    assert.match(JSON.stringify(commands), /agent-chat/);
    const openedCommand = await daemon.request({ type: "prompt", activeSessionId: alphaNative.activeSessionId,
      message: "/agent-chat", source: "interactive" });
    assert(openedCommand.success, JSON.stringify(openedCommand));
    const opened: unknown = JSON.parse(await waitForChatNativeFile(asideUrl, text => text.length > 0));
    assert(typeof opened === "object" && opened !== null && "url" in opened && typeof opened.url === "string");
    const page = await fetch(opened.url);
    assert.equal(page.status, 200);
    await writeFile(join(root, "chat.html"), await page.text());
    if (process.env.CHAT_TEST_BROWSER === "1") {
      const browserDone = join(root, "browser-done");
      await writeFile(join(root, "browser-ready.json"), JSON.stringify({ url: opened.url, browserDone, alpha, beta, saved }));
      process.stdout.write(`CHAT_TEST_BROWSER_READY ${JSON.stringify({ url: opened.url, browserDone, root })}\n`);
      await waitForChatNativeFile(browserDone, () => true, 300000);
    }
    await backend.close();
    await backend.close();
    const afterClose = await nativeRows(daemon);
    assert.deepEqual(afterClose.filter(row => row.sessionId !== replacement.sessionId), before,
      "closing a viewer never kills or changes worker identities");
    for (const row of [alphaNative, betaNative]) {
      assert(row.workerPid && row.activeSessionId);
      process.kill(row.workerPid, 0);
      const state = await daemon.request({ type: "get_state", activeSessionId: row.activeSessionId });
      assert(state.success, JSON.stringify(state));
    }
    assert.deepEqual(await readFile(saved.sessionFile), savedBytes);
    const syntheticModelCalls = (await readFile(calls, "utf8")).split('"stage":"start"').length - 1;
    await writeFile(join(root, "result.json"), JSON.stringify({ passed: true, socket, supervisorPid,
      cliPid: native.child.pid, workers: afterClose, syntheticModelCalls, automatedModelCalls: 3, realModelCalls: 0,
      browserReview: process.env.CHAT_TEST_BROWSER === "1", savedBytesUnchanged: true,
      queueDidNotInterrupt: true, closePreservedWorkers: true, modelChangesTargeted: true,
      latestModelUsed: visionModel.id, nativeUsage: withImages.usage, imageBytesPreserved: true }, null, 2));
  } finally {
    await backend?.close();
    await native.close();
    try { await stopChatNativeDaemon(daemon, socket); }
    finally {
      daemon.close();
      const logs = native.logs();
      await writeFile(join(root, "stdout.jsonl"), logs.stdout);
      await writeFile(join(root, "stderr.txt"), logs.stderr);
      process.stdout.write(`Native chat test artifacts: ${root}\n`);
    }
  }
  await assert.rejects(access(socket), { code: "ENOENT" });
});
