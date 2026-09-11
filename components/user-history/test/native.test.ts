import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DaemonClient, SessionManager } from "prime-agent";
import { populateHistory } from "./native-fixture.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const primeRoot = resolve(dirname(fileURLToPath(import.meta.resolve("prime-agent"))), "..");
const node = process.execPath;
const cli = join(primeRoot, "dist/bundle/cli.js");

test("installed CLI/daemon executes read-only history command with zero model calls", { timeout: 90000 }, async () => {
  const browser = process.env.HISTORY_TEST_BROWSER === "1";
  const realAside = process.env.HISTORY_TEST_REAL_ASIDE === "1";
  assert(!(browser && realAside), "Choose manual browser review or the real Aside opener, not both");
  const id = randomBytes(6).toString("hex");
  const root = join(packageRoot, ".test-artifacts", `native-${id}`);
  const home = join(root, "home");
  const config = join(home, ".prime/agent");
  const cwd = join(root, "project");
  const sessions = join(root, "sessions");
  const socket = `/tmp/wh-${id}.sock`;
  const temporary = `/tmp/wht-${id}`;
  await Promise.all([home, config, cwd, sessions, temporary].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(config, "settings.json"), JSON.stringify({ onboardingShown: true, onboardingCompleted: true,
    telemetry: { enabled: false, noticeShown: true }, compaction: { enabled: false }, retry: { enabled: false },
    mcpServers: {}, packages: [], extensions: [], skills: [] }));
  const env = { HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: "en_US.UTF-8", TERM: "dumb",
    PRIME_AGENT_CODING_AGENT_DIR: config, PRIME_AGENT_SESSION_DIR: sessions, PRIME_AGENT_TELEMETRY: "0" };
  const manager = SessionManager.create(cwd, sessions);
  populateHistory(manager);
  manager.flushNow();
  const sessionFile = manager.getSessionFile();
  assert(sessionFile);
  const originalEntries = SessionManager.open(sessionFile, sessions).getEntries();
  const aside = join(root, "aside-test.mjs");
  const capture = join(root, "captured.html");
  const calls = join(root, "model-calls.txt");
  const inspection = join(root, "inspection.json");
  if (!realAside) await writeFile(aside, `#!${node}
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args.length, 3);
const [flag, bundle, url] = args;
assert.equal(flag, '-b');
assert.equal(bundle, 'at.studio.AsideBrowser');
assert.equal(new URL(url).hostname, '127.0.0.1');
await writeFile(${JSON.stringify(join(root, "aside-url.json"))}, JSON.stringify({ url, args }));
if (!${JSON.stringify(browser)}) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  await writeFile(${JSON.stringify(capture)}, await response.text());
}
`, { mode: 0o700 });
  const wrapper = join(root, "extension.ts");
  await writeFile(wrapper, `import historyExtension from ${JSON.stringify(join(packageRoot, "extension/index.ts"))};
import { writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from 'prime-agent';
export default function(pi: ExtensionAPI) {
  historyExtension(pi${realAside ? "" : `, ${JSON.stringify(aside)}`});
  pi.registerProvider('history-test', {
    baseUrl: 'http://127.0.0.1:1/never', apiKey: 'synthetic-not-a-secret', api: 'history-test-api',
    models: [{ id: 'synthetic', name: 'Synthetic no-inference model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1 }],
    streamSimple() { appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify("FORBIDDEN MODEL CALL\n")}); throw new Error('Model calls forbidden'); }
  });
  pi.registerCommand('history-test-inspect', { description: 'Synthetic read-only assertion', async handler(args, ctx) {
    await writeFile(${JSON.stringify(inspection)}, JSON.stringify({ leaf: ctx.sessionManager.getLeafId(), entries: ctx.sessionManager.getEntries(), branch: ctx.sessionManager.getBranch(), pid: process.pid }));
    ctx.ui.notify("Inspection saved", "info");
  } });
}
`);
  const args = [cli, "--mode", "rpc", "--daemon-socket", socket, "--cwd", cwd, "--no-extensions", "-e", wrapper,
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools", "--no-themes",
    "--provider", "history-test", "--model", "synthetic", "--resume", sessionFile];
  const child = spawn(node, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  let pending = "";
  let nextId = 0;
  const notices = new Set<{ resolve(message: string): void; reject(error: Error): void }>();
  const responses = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (typeof value !== "object" || value === null || !("type" in value)) continue;
      if (value.type === "extension_ui_request" && "method" in value && value.method === "notify" &&
          "message" in value && typeof value.message === "string") {
        for (const notice of notices) notice.resolve(value.message);
        notices.clear();
      }
      if (value.type === "extension_error") {
        for (const notice of notices) notice.reject(new Error(JSON.stringify(value)));
        notices.clear();
      }
      if (value.type !== "response" || !("id" in value) || typeof value.id !== "string") continue;
      const waiter = responses.get(value.id);
      if (!waiter) continue;
      responses.delete(value.id);
      if ("success" in value && value.success === true) waiter.resolve(value);
      else waiter.reject(new Error(JSON.stringify(value)));
    }
  });
  const exited = once(child, "exit");
  child.once("exit", () => {
    for (const waiter of responses.values()) waiter.reject(new Error(`Native CLI exited. ${stderr}`));
    responses.clear();
  });
  function rpc(command: { type: string; message?: string }): Promise<unknown> {
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { responses.delete(id); reject(new Error(`RPC timeout. ${stderr}\n${stdout}`)); }, 45000);
      responses.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }
  async function command(message: string, expectedNotice: string): Promise<void> {
    const notice = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No command completion notice. ${stdout}`)), 40000);
      notices.add({ resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    });
    const [, result] = await Promise.all([rpc({ type: "prompt", message }), notice]);
    assert.equal(result, expectedNotice);
  }
  const daemon = new DaemonClient(socket);
  let supervisorPid: number | undefined;
  let workerPid: number | undefined;
  try {
    const commands = await rpc({ type: "get_commands" });
    assert.match(JSON.stringify(commands), /what-did-i-say/);
    await daemon.connect();
    supervisorPid = (await daemon.waitForHello()).supervisorPid;
    assert(supervisorPid && supervisorPid !== child.pid);
    await command("/history-test-inspect", "Inspection saved");
    const before = await readFile(inspection, "utf8");
    const beforeValue: unknown = JSON.parse(before);
    assert(typeof beforeValue === "object" && beforeValue !== null && "pid" in beforeValue && typeof beforeValue.pid === "number");
    workerPid = beforeValue.pid;
    assert.notEqual(workerPid, child.pid);
    assert.notEqual(workerPid, supervisorPid);
    process.stdout.write(realAside
      ? `Native test uses the real Aside URL handler. Check the new tab after test exit. Artifacts: ${root}\n`
      : `Native test ready. URL artifact: ${join(root, "aside-url.json")}\n`);
    await command("/what-did-i-say", "Opened saved questions and final responses in Aside.");
    let htmlBytes: number | null = null;
    if (!browser && !realAside) {
    const html = await readFile(capture, "utf8");
    htmlBytes = Buffer.byteLength(html);
    assert(html.indexOf("FIRST SAVED QUESTION") < html.indexOf("FIRST FINAL"));
    assert(html.indexOf("FIRST FINAL") < html.indexOf("LAST SAVED QUESTION"));
    for (const expected of ["Skill /skill:synthetic", "Text before skill", "Text after image", "Injected instructions",
      "Earlier final responses (1)", "LATEST MARKED FINAL", "No marked final response saved", "UNMARKED SAVED REPLY", "Recorded final 59"]) assert(html.includes(expected), expected);
    assert.doesNotMatch(html, /FORBIDDEN|<script|<img|href=|src=/);
    }
    await command("/history-test-inspect", "Inspection saved");
    assert.equal(await readFile(inspection, "utf8"), before, "active leaf, branch and all saved entries stay unchanged");
    const persisted = SessionManager.open(sessionFile, sessions).getEntries();
    assert.deepEqual(persisted.filter(entry => entry.type === "message" || entry.type === "compaction" || entry.type === "custom_message"), originalEntries);
    await assert.rejects(access(calls), { code: "ENOENT" });
    assert.doesNotMatch(stdout, /"type":"agent_start"/);
    await writeFile(join(root, "result.json"), JSON.stringify({ passed: true, socket, cliPid: child.pid, supervisorPid, workerPid,
      modelCalls: 0, browserReview: browser, realAside, postExitTabCheckRequired: realAside, htmlBytes, savedEntryCount: originalEntries.length }, null, 2));
  } finally {
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { if (child.exitCode === null && child.signalCode === null) await exited; } finally { clearTimeout(killTimer); }
    try {
      if (!daemon.isConnected) await daemon.connect(1000);
      const socketRemoved = new Promise<void>((resolve, reject) => {
        const watcher = watch(dirname(socket), (_event, file) => {
          if ((file === null || file === basename(socket)) && !existsSync(socket)) {
            clearTimeout(timer);
            watcher.close();
            resolve();
          }
        });
        const timer = setTimeout(() => { watcher.close(); reject(new Error("Owned daemon socket remained after shutdown")); }, 10000);
      });
      await Promise.all([daemon.request({ type: "shutdown", force: true }, 10000), socketRemoved]);
    } finally {
      daemon.close();
      await writeFile(join(root, "stdout.jsonl"), stdout);
      await writeFile(join(root, "stderr.txt"), stderr);
      process.stdout.write(`Native test artifacts: ${root}\n`);
    }
  }
  await assert.rejects(access(socket), { code: "ENOENT" });
});
