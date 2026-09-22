import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, access, symlink, unlink } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { DaemonClient, SessionManager } from "prime-agent";
import type { SessionsEvent, ThreadEvent, ThreadState } from "../src/shared/types.ts";
import { applyThreadEvent } from "../src/shared/thread-state.ts";
import { messageText } from "../src/shared/turns.ts";
import { chatNativeProviderSource, startChatNativeCli, stopChatNativeDaemon, waitForChatNativeFile } from "./chat-native-fixture.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const primeRoot = resolve(dirname(fileURLToPath(import.meta.resolve("prime-agent"))), "..");
const node = process.execPath;
const cli = join(primeRoot, "dist/bundle/cli.js");
const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=" };
const requestId = () => randomBytes(12).toString("hex");

type Frame<T> = { event: string; data: T };
function openStream<T>(url: string) {
  const frames: Frame<T>[] = [];
  const waiters: { predicate: (frame: Frame<T>) => boolean; resolve(frame: Frame<T>): void }[] = [];
  let text = "";
  let error: Error | undefined;
  const req = request(url, { headers: { "Accept-Encoding": "gzip" } });
  req.on("response", res => {
    const decoded = res.headers["content-encoding"] === "gzip" ? res.pipe(createGunzip()) : res;
    decoded.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      let match: RegExpExecArray | null;
      while ((match = /event: (\w+)\ndata: (.*)\n\n/.exec(text))) {
        text = text.slice(match.index + match[0].length);
        const frame = { event: match[1]!, data: JSON.parse(match[2]!) as T };
        frames.push(frame);
        for (const waiter of [...waiters]) if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
      }
    });
    decoded.on("error", failure => { error = failure; });
  });
  req.on("error", failure => { error = failure; });
  req.end();
  return {
    frames,
    waitFor(predicate: (frame: Frame<T>) => boolean, timeout = 30000, label = "frame"): Promise<Frame<T>> {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.splice(waiters.findIndex(waiter => waiter.resolve === done), 1); reject(new Error(`Timed out waiting for ${label}. ${error?.message ?? ""}\n${JSON.stringify(frames.slice(-5)).slice(0, 2000)}`)); }, timeout);
        const done = (frame: Frame<T>) => { clearTimeout(timer); resolve(frame); };
        waiters.push({ predicate, resolve: done });
      });
    },
    close() { req.destroy(); },
  };
}

function threadWatcher(url: string) {
  const stream = openStream<ThreadEvent>(url);
  let state: ThreadState | undefined;
  const events: ThreadEvent[] = [];
  const reduced = new Promise<void>(resolve => { resolve(); });
  void reduced;
  const apply = (frame: Frame<ThreadEvent>) => {
    events.push(frame.data);
    if (frame.data.type === "snapshot") state = applyThreadEvent({ ...frame.data.snapshot, connection: "connected" }, frame.data);
    else if (state) state = applyThreadEvent(state, frame.data);
  };
  const original = stream.waitFor;
  let applied = 0;
  const sync = () => { while (applied < stream.frames.length) apply(stream.frames[applied++]!); };
  return {
    ...stream,
    events,
    get state() { sync(); return state; },
    waitFor: async (predicate: (event: ThreadEvent) => boolean, timeout = 30000, label = "thread event") => {
      const frame = await original(frame => predicate(frame.data), timeout, label);
      sync();
      return frame.data;
    },
  };
}

function seedSession(cwd: string, sessions: string, name: string) {
  const previousDepth = process.env.RLM_DEPTH;
  process.env.RLM_DEPTH = "0";
  const manager = SessionManager.create(cwd, sessions);
  if (previousDepth === undefined) delete process.env.RLM_DEPTH; else process.env.RLM_DEPTH = previousDepth;
  manager.appendSessionInfo(name);
  manager.appendModelChange("chat-native-test", "synthetic");
  manager.appendMessage({ role: "user", content: `SAVED QUESTION ${name}`, timestamp: 1000 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `SAVED ANSWER ${name}` }], api: "chat-native-test-api", provider: "chat-native-test", model: "synthetic",
    stopReason: "stop", timestamp: 1001, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.flushNow();
  const sessionFile = manager.getSessionFile();
  assert(sessionFile);
  return { sessionId: manager.getSessionId(), sessionFile, name };
}

test("browser chat drives native sessions: create, stream, follow up, resume, stop, model, tools, sessions list", { timeout: 180000 }, async context => {
  const id = randomBytes(6).toString("hex");
  const root = join(process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(packageRoot, ".test-artifacts"), `chat-native-${id}`);
  const home = join(root, "home");
  const config = join(home, ".prime/agent");
  const cwd = join(root, "project");
  const sessions = join(root, "sessions");
  const socket = `/tmp/wc-${id}.sock`;
  const temporary = `/tmp/wct-${id}`;
  const nativeTemp = join(root, "native-temp");
  await Promise.all([home, config, cwd, sessions, nativeTemp].map(path => mkdir(path, { recursive: true })));
  await symlink(nativeTemp, temporary);
  context.after(async () => { await unlink(temporary); });
  const env = { HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: "en_US.UTF-8", TERM: "dumb",
    PRIME_AGENT_CODING_AGENT_DIR: config, PRIME_AGENT_SESSION_DIR: sessions, PRIME_AGENT_TELEMETRY: "0", PI_OFFLINE: "1" };
  const calls = join(root, "provider-calls.jsonl");
  const gate = join(root, "release-provider");
  const provider = join(root, "provider.mjs");
  const extension = join(root, "extension.ts");
  await writeFile(calls, "");
  await writeFile(provider, chatNativeProviderSource({ calls, gate, aiModule: fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")) }));
  await writeFile(extension, `import historyExtension from ${JSON.stringify(join(packageRoot, "extension/index.ts"))};\nimport provider from ${JSON.stringify(provider)};\nexport default function(pi) { historyExtension(pi); provider(pi); }\n`);
  await writeFile(join(config, "settings.json"), JSON.stringify({ onboardingShown: true, onboardingCompleted: true, telemetry: { enabled: false, noticeShown: true },
    compaction: { enabled: false }, retry: { enabled: false }, defaultProvider: "chat-native-test", defaultModel: "synthetic", mcpServers: {}, packages: [], extensions: [provider], skills: [] }));
  const skillDir = join(config, "skills", "browser-proof");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: browser-proof\ndescription: Native browser skill verification\n---\nNATIVE_SKILL_PROOF. Keep the supplied argument.\n");
  const saved = seedSession(cwd, sessions, `chat-saved-${id}`);
  const moved = seedSession(cwd, sessions, `chat-moved-${id}`);
  const savedBytes = await readFile(saved.sessionFile);
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); assert(address && typeof address !== "string");
  const chatPort = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const chatData = join(config, "browser-chat");
  const chatCli = async (command: string) => (await promisify(execFile)(node,
    [join(packageRoot, "../../scripts/cli.mjs"), "chat", command, "--port", String(chatPort), "--socket", socket, "--data-dir", chatData], { env, timeout: 40000 })).stdout.trim();
  context.after(async () => { await chatCli("stop").catch(() => {}); });
  const chatUrl = await chatCli("start");
  const shell = await fetch(chatUrl);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  const token = html.match(/data-chat-token="([a-f0-9]{64})"/)?.[1]; assert(token, "shell carries the write token");
  assert.match(html, /app\.js/);
  assert.equal((await fetch(chatUrl + "app.js")).status, 200);
  assert.match(shell.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const beforeDaemon = openStream<SessionsEvent>(chatUrl + "api/sessions/stream");
  const down = await beforeDaemon.waitFor(frame => frame.event === "sessions", 15000, "daemon-down sessions frame");
  assert.equal(down.data.daemon, "down", "the sessions stream reports the daemon as down before it starts");
  beforeDaemon.close();
  const headers = { "Content-Type": "application/json", Origin: new URL(chatUrl).origin, "X-Chat-Token": token };
  const post = async (route: string, body: unknown) => {
    const response = await fetch(chatUrl + route, { method: "POST", headers, body: JSON.stringify(body) });
    const value: unknown = await response.json();
    return { status: response.status, body: value as Record<string, unknown> };
  };
  const nativeArgs = [cli, "--mode", "rpc", "--daemon-socket", socket, "--agent-chat-socket", socket, "--agent-chat-port", String(chatPort), "--agent-chat-data-dir", chatData,
    "--cwd", cwd, "--no-extensions", "-e", extension, "--no-skills", "--skill", join(skillDir, "SKILL.md"), "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
    "--tools", "browser_proof_tool", "--no-themes", "--provider", "chat-native-test", "--model", "synthetic", "--no-session"];
  const native = startChatNativeCli({ node, cwd, env, args: nativeArgs });
  const daemon = new DaemonClient(socket);
  const watchers: { events: ThreadEvent[] }[] = [];
  try {
    await native.rpc("get_state");
    await daemon.connect();
    await daemon.waitForHello();
    const sessionsStream = openStream<SessionsEvent>(chatUrl + "api/sessions/stream");
    const initial = await sessionsStream.waitFor(frame => frame.event === "sessions" && frame.data.daemon === "up", 20000, "sessions with daemon up");
    assert.deepEqual(initial.data.sessions.map(row => row.id).sort(), [saved.sessionId, moved.sessionId].sort(), "the isolated catalog lists the seeded saved threads only");
    assert.equal(initial.data.sessions.find(row => row.id === saved.sessionId)?.kind, "saved");
    assert.equal(initial.data.sessions.find(row => row.id === saved.sessionId)?.name, saved.name);
    await rename(moved.sessionFile, moved.sessionFile + ".away");
    const gone = openStream<ThreadEvent>(chatUrl + `api/threads/${moved.sessionId}/stream`);
    const goneStatus = await gone.waitFor(frame => frame.data.type === "status", 20000, "moved-file status");
    assert(goneStatus.data.type === "status" && goneStatus.data.connection === "closed");
    assert.match(goneStatus.data.error ?? "", /moved or deleted/, "a saved thread whose file moved says so instead of claiming the file changed");
    gone.close();
    await sessionsStream.waitFor(frame => frame.data.sessions.every(row => row.id !== moved.sessionId), 20000, "moved row leaves the list");
    assert.equal((await fetch(chatUrl + "api/workspaces").then(response => response.json()) as { workspaces: { cwd: string }[] }).workspaces[0]?.cwd, cwd);
    const rejected = await post("api/threads", { cwd, message: "no request id" });
    assert.equal(rejected.status, 400);
    const forbidden = await fetch(chatUrl + "api/threads", { method: "POST", headers: { "Content-Type": "application/json", Origin: headers.Origin }, body: "{}" });
    assert.equal(forbidden.status, 403, "writes need the page token");

    const firstPrompt = `FIRST ${id} [hold]`;
    const creation = requestId();
    const created = await post("api/threads", { cwd, message: firstPrompt, requestId: creation });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const threadId = created.body.id;
    assert(typeof threadId === "string" && threadId);
    assert.deepEqual((await post("api/threads", { cwd, message: firstPrompt, requestId: creation })).body, { id: threadId }, "creation is idempotent per request ID");
    const thread = threadWatcher(chatUrl + `api/threads/${threadId}/stream`);
    watchers.push(thread);
    const snapshot = await thread.waitFor(event => event.type === "snapshot", 20000, "first snapshot");
    assert(snapshot.type === "snapshot");
    assert.equal(snapshot.snapshot.kind, "live");
    assert.equal(snapshot.snapshot.info.cwd, cwd);
    assert.equal(snapshot.snapshot.info.model?.id, "synthetic");
    await waitForChatNativeFile(calls, text => text.includes('"stage":"held"'));
    await thread.waitFor(event => event.type === "event" && event.event.type === "message_update", 20000, "streaming update");
    const streaming = thread.state; assert(streaming);
    await writeFile(join(root, "events-early.json"), JSON.stringify(thread.events, null, 1));
    assert(streaming.messages.some(message => message.role === "user" && messageText(message) === firstPrompt), "the first user message is in the snapshot or events");
    assert.equal(streaming.info.isStreaming, true);
    assert.equal(streaming.streaming?.role, "assistant");
    assert.match(JSON.stringify(streaming.streaming?.content), /SYNTHETIC REPLY: /);
    const running = await sessionsStream.waitFor(frame => frame.data.sessions.some(row => row.id === threadId && row.status === "running"), 20000, "sessions row running");
    assert.equal(running.data.sessions.find(row => row.id === threadId)?.kind, "live");
    const secondPrompt = `SECOND ${id}`;
    const queuedSend = await post(`api/threads/${threadId}/prompt`, { message: secondPrompt, requestId: requestId(), mode: "followUp" });
    assert.equal(queuedSend.status, 200, JSON.stringify(queuedSend.body));
    await thread.waitFor(event => event.type === "queue" && event.queue.followUp.includes(secondPrompt), 20000, "queue chip");
    await writeFile(gate, "release");
    await thread.waitFor(event => event.type === "event" && event.event.type === "message_end" && event.event.message.role === "assistant" && JSON.stringify(event.event.message.content).includes(secondPrompt), 30000, "second reply");
    await thread.waitFor(event => event.type === "info" && !event.info.isStreaming, 20000, "idle info");
    await thread.waitFor(event => event.type === "queue" && event.queue.followUp.length === 0, 20000, "queue drained");
    const afterTwo = thread.state; assert(afterTwo);
    const texts = afterTwo.messages.map(message => message.role === "user" || message.role === "assistant" ? messageText(message) : message.role);
    assert.deepEqual(texts, [firstPrompt, `SYNTHETIC REPLY: ${firstPrompt}`, secondPrompt, `SYNTHETIC REPLY: ${secondPrompt}`]);
    assert.equal(afterTwo.streaming, null);
    assert.deepEqual(afterTwo.queue, { steering: [], followUp: [] });
    await sessionsStream.waitFor(frame => frame.data.sessions.some(row => row.id === threadId && row.status === "idle" && row.messageCount >= 4), 20000, "sessions row idle");

    await unlink(gate);
    const stopPrompt = `STOP ME ${id} [hold]`;
    await post(`api/threads/${threadId}/prompt`, { message: stopPrompt, requestId: requestId(), mode: "followUp" });
    await waitForChatNativeFile(calls, text => text.split('"stage":"held"').length - 1 >= 2);
    await thread.waitFor(event => event.type === "event" && event.event.type === "message_update" && JSON.stringify(event.event.message.content).includes("SYNTHETIC REPLY: ") && event.event.message.timestamp > afterTwo.messages.at(-1)!.timestamp, 20000, "held reply streaming");
    assert.equal((await post(`api/threads/${threadId}/abort`, {})).status, 200);
    const aborted = await thread.waitFor(event => event.type === "event" && event.event.type === "message_end" && event.event.message.role === "assistant" && event.event.message.stopReason === "aborted", 30000, "aborted reply");
    assert(aborted.type === "event" && aborted.event.type === "message_end" && aborted.event.message.role === "assistant");
    await thread.waitFor(event => event.type === "info" && !event.info.isStreaming, 20000, "idle after abort");
    assert.equal(thread.state?.streaming, null);

    const models = await fetch(chatUrl + `api/models?id=${threadId}`).then(response => response.json()) as { current: { id: string } | null; models: { provider: string; id: string }[]; availableThinkingLevels: string[] };
    assert.equal(models.current?.id, "synthetic");
    assert(models.models.some(model => model.provider === "chat-native-test" && model.id === "synthetic-vision"));
    assert.equal((await post(`api/threads/${threadId}/model`, { provider: "chat-native-test", modelId: "synthetic-vision" })).status, 200);
    await thread.waitFor(event => event.type === "info" && event.info.model?.id === "synthetic-vision", 20000, "model info");
    const level = models.availableThinkingLevels.find(candidate => candidate !== thread.state?.info.thinkingLevel);
    if (level) {
      assert.equal((await post(`api/threads/${threadId}/thinking`, { level })).status, 200);
      await thread.waitFor(event => event.type === "info" && event.info.thinkingLevel === level, 20000, "thinking info");
    }
    assert.equal((await post(`api/threads/${threadId}/thinking`, { level: "invented" })).status, 400);
    assert.equal((await post(`api/threads/${threadId}/rename`, { name: `Renamed ${id}` })).status, 200);
    await thread.waitFor(event => event.type === "info" && event.info.name === `Renamed ${id}`, 20000, "rename info");
    await sessionsStream.waitFor(frame => frame.data.sessions.some(row => row.id === threadId && row.name === `Renamed ${id}`), 20000, "renamed row");
    const imagePrompt = `WITH IMAGE ${id}`;
    assert.equal((await post(`api/threads/${threadId}/prompt`, { message: imagePrompt, images: [png], requestId: requestId(), mode: "followUp" })).status, 200);
    const imageUser = await thread.waitFor(event => event.type === "event" && event.event.type === "message_end" && event.event.message.role === "user" && JSON.stringify(event.event.message.content).includes(imagePrompt), 20000, "image user message");
    assert(imageUser.type === "event" && imageUser.event.type === "message_end" && imageUser.event.message.role === "user" && Array.isArray(imageUser.event.message.content));
    const imagePart = imageUser.event.message.content.find(part => part.type === "image");
    assert(imagePart && imagePart.type === "image" && /^api\/images\/[a-f0-9]{64}$/.test(imagePart.url), "images are served by hash, not inlined");
    const image = await fetch(chatUrl + imagePart.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString("base64"), png.data);
    await thread.waitFor(event => event.type === "info" && !event.info.isStreaming && event.info.messageCount >= 8, 30000, "idle after image");

    const toolPrompt = `TOOL ${id} [tool]`;
    assert.equal((await post(`api/threads/${threadId}/prompt`, { message: toolPrompt, requestId: requestId(), mode: "followUp" })).status, 200);
    await thread.waitFor(event => event.type === "event" && event.event.type === "tool_execution_start", 30000, "tool start");
    await waitForChatNativeFile(calls, text => text.includes('"stage":"tool-held"'));
    await thread.waitFor(event => event.type === "event" && event.event.type === "tool_execution_update", 20000, "tool update");
    const duringTool = thread.state; assert(duringTool);
    assert.equal(duringTool.tools[0]?.toolName, "browser_proof_tool");
    assert.equal(duringTool.tools[0]?.status, "running");
    assert.match(duringTool.tools[0]?.partial ?? "", /waiting for the test release/);
    const commands = await fetch(chatUrl + `api/threads/${threadId}/commands`).then(response => response.json()) as { commands: { name: string; source: string }[] };
    assert(commands.commands.some(command => command.name === "skill:browser-proof" && command.source === "skill"));
    await writeFile(gate + ".tool", "release");
    await writeFile(gate, "release");
    const toolEnd = await thread.waitFor(event => event.type === "event" && event.event.type === "message_end" && event.event.message.role === "toolResult", 30000, "tool result");
    assert(toolEnd.type === "event" && toolEnd.event.type === "message_end" && toolEnd.event.message.role === "toolResult");
    const toolCallId = toolEnd.event.message.toolCallId;
    const output = await fetch(chatUrl + `api/threads/${threadId}/tool-output?toolCallId=${encodeURIComponent(toolCallId)}`).then(response => response.json()) as { output: string; toolName: string; isError: boolean | null };
    assert.equal(output.toolName, "browser_proof_tool");
    assert.match(output.output, /NATIVE_TOOL_RESULT/);
    assert.equal(output.isError, false);
    await thread.waitFor(event => event.type === "info" && !event.info.isStreaming && event.info.messageCount >= 11, 30000, "idle after tool");
    assert.deepEqual(thread.state?.tools, [], "tool runs clear when the run ends");
    assert.equal((await post(`api/threads/${threadId}/prompt`, { message: "/unknown-command", requestId: requestId() })).status, 400);
    assert.equal((await post(`api/threads/${threadId}/read`, {})).status, 200);
    await sessionsStream.waitFor(frame => frame.data.sessions.some(row => row.id === threadId && row.unread === false), 20000, "read marker");

    const savedThread = threadWatcher(chatUrl + `api/threads/${saved.sessionId}/stream`);
    watchers.push(savedThread);
    const savedSnapshot = await savedThread.waitFor(event => event.type === "snapshot", 20000, "saved snapshot");
    assert(savedSnapshot.type === "snapshot");
    assert.equal(savedSnapshot.snapshot.kind, "saved");
    assert.equal(savedSnapshot.snapshot.messages.length, 2);
    assert.equal(savedSnapshot.snapshot.info.name, saved.name);
    assert.deepEqual(await readFile(saved.sessionFile), savedBytes, "reading a saved thread does not touch its file");
    const resumePrompt = `RESUME ${id}`;
    const resumed = await post(`api/threads/${saved.sessionId}/prompt`, { message: resumePrompt, requestId: requestId(), mode: "followUp" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const liveSnapshot = await savedThread.waitFor(event => event.type === "snapshot" && event.snapshot.kind === "live", 30000, "resumed live snapshot");
    assert(liveSnapshot.type === "snapshot");
    assert.equal(liveSnapshot.snapshot.info.sessionId, saved.sessionId);
    await savedThread.waitFor(event => event.type === "event" && event.event.type === "message_end" && event.event.message.role === "assistant" && JSON.stringify(event.event.message.content).includes(resumePrompt), 30000, "resumed reply");
    await savedThread.waitFor(event => event.type === "info" && !event.info.isStreaming, 20000, "resumed idle");
    const resumedTexts = savedThread.state?.messages.map(message => message.role === "user" || message.role === "assistant" ? messageText(message) : message.role);
    assert.deepEqual(resumedTexts, [`SAVED QUESTION ${saved.name}`, `SAVED ANSWER ${saved.name}`, resumePrompt, `SYNTHETIC REPLY: ${resumePrompt}`]);
    await sessionsStream.waitFor(frame => frame.data.sessions.some(row => row.id === saved.sessionId && row.kind === "live" && row.status === "idle"), 20000, "saved row is live now");
    const entries = SessionManager.open(saved.sessionFile, sessions).getEntries();
    assert(entries.some(entry => entry.type === "message" && entry.message.role === "user" && messageText(entry.message) === resumePrompt), "the resumed reply persists in the native file");

    const starts = (await readFile(calls, "utf8")).split('"stage":"start"').length - 1;
    assert.equal(starts, 7, "seven provider calls: first, second, stopped, image, tool (two legs), resume");
    thread.close();
    savedThread.close();
    sessionsStream.close();
    await writeFile(join(root, "result.json"), JSON.stringify({ passed: true, threadId, savedId: saved.sessionId, providerStarts: starts, events: thread.events.length }, null, 2));
  } finally {
    await writeFile(join(root, "thread-events.json"), JSON.stringify(watchers.map(watcher => watcher.events), null, 1)).catch(() => {});
    await chatCli("stop").catch(() => {});
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
