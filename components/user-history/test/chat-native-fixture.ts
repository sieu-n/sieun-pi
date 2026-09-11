import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { DaemonClient } from "prime-agent";

export function startChatNativeCli(input: { node: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(input.node, input.args, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let pending = "";
  let nextId = 0;
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
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "response" ||
        !("id" in value) || typeof value.id !== "string") continue;
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
  return {
    child,
    logs: () => ({ stdout, stderr }),
    rpc(type: string, message?: string): Promise<unknown> {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { responses.delete(id); reject(new Error(`RPC timeout. ${stderr}\n${stdout}`)); }, 30000);
        responses.set(id, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(JSON.stringify({ type, id, ...(message === undefined ? {} : { message }) }) + "\n");
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { if (child.exitCode === null && child.signalCode === null) await exited; }
      finally { clearTimeout(timer); }
    },
  };
}

export function waitForChatNativeFile(path: string, ready: (text: string) => boolean, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, file) => {
      if (file === null || file === basename(path)) void check();
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`Timed out waiting for ${path}`)); }, timeout);
    async function check() {
      try {
        const text = await readFile(path, "utf8");
        if (ready(text)) { clearTimeout(timer); watcher.close(); resolve(text); }
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
        clearTimeout(timer); watcher.close(); reject(error);
      }
    }
    void check();
  });
}

export async function stopChatNativeDaemon(daemon: DaemonClient, socket: string): Promise<void> {
  if (!daemon.isConnected) await daemon.connect(1000);
  const removed = new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(socket), (_event, file) => {
      if ((file === null || file === basename(socket)) && !existsSync(socket)) {
        clearTimeout(timer); watcher.close(); resolve();
      }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Owned chat daemon socket remained after shutdown")); }, 10000);
  });
  const [result] = await Promise.all([daemon.request({ type: "shutdown", force: true }, 10000), removed]);
  assert(result.success, JSON.stringify(result));
}

export function chatNativeProviderSource(input: { aiModule: string; calls: string; gate: string }): string {
  return `import { createAssistantMessageEventStream } from ${JSON.stringify(input.aiModule)};
import { appendFileSync, existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';
const calls = ${JSON.stringify(input.calls)};
const gate = ${JSON.stringify(input.gate)};
function log(stage, message, details = {}) { appendFileSync(calls, JSON.stringify({ stage, message, pid: process.pid, ...details }) + '\\n'); }
function waitForRelease(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Synthetic provider aborted')); };
    const check = () => { if (existsSync(gate)) { cleanup(); resolve(); } };
    const watcher = watch(dirname(gate), check);
    const timer = setTimeout(() => { cleanup(); reject(new Error('Synthetic release gate timed out')); }, 45000);
    function cleanup() { watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else check();
  });
}
export default function(pi) {
  pi.registerProvider('chat-native-test', {
    baseUrl: 'http://127.0.0.1:1/never', apiKey: 'synthetic-not-a-secret', api: 'chat-native-test-api',
    models: [
      { id: 'synthetic', name: 'Deterministic native chat fixture', reasoning: false, input: ['text'],
        cost: { input: 10, output: 100, cacheRead: 1, cacheWrite: 10 }, contextWindow: 1000000, maxTokens: 1024 },
      { id: 'synthetic-vision', name: 'Deterministic native vision fixture', reasoning: false, input: ['text', 'image'],
        cost: { input: 10, output: 100, cacheRead: 1, cacheWrite: 10 }, contextWindow: 2000000, maxTokens: 1024 },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.findLast(message => message.role === 'user');
      const text = typeof user?.content === 'string' ? user.content
        : (user?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\\n');
      const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 100, output: 25, cacheRead: 40, cacheWrite: 10, totalTokens: 175,
          cost: { input: 0.001, output: 0.0025, cacheRead: 0.00004, cacheWrite: 0.0001, total: 0.00364 } },
        stopReason: 'stop', timestamp: Date.now() };
      void (async () => {
        try {
          log('start', text, { provider: model.provider, model: model.id, content: user?.content });
          stream.push({ type: 'start', partial: output });
          const block = { type: 'text', text: '' };
          output.content.push(block);
          stream.push({ type: 'text_start', contentIndex: 0, partial: output });
          block.text = 'SYNTHETIC REPLY: ';
          stream.push({ type: 'text_delta', contentIndex: 0, delta: block.text, partial: output });
          if (text.includes('[hold]')) { log('held', text); await waitForRelease(options?.signal); }
          block.text += text;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output });
          stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: output });
          log('done', text);
          stream.push({ type: 'done', reason: 'stop', message: output });
          stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          output.errorMessage = String(error);
          log(output.stopReason, text);
          stream.push({ type: 'error', reason: output.stopReason, error: output });
          stream.end();
        }
      })();
      return stream;
    }
  });
}
`;
}
