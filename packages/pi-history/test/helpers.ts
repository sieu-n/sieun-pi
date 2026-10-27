import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const ROOT = "01a17f00-0000-7000-8000-000000000001";
export const CHILD = "01a17f00-0000-7000-8000-000000000002";

const homes: string[] = [];
process.on("exit", () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

export function tempHome(): { home: string; dirs: string[]; rootFile: string; childFile: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-history-test-"));
  homes.push(home);
  const dirs = [join(home, "sessions"), join(home, "session-artifacts"), join(home, "pi-sessions")];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const rootFile = join(home, "sessions", `${ROOT}.jsonl`);
  const childFile = join(home, "session-artifacts", ROOT, "sub-0000aaaa", "sub-0000bbbb", `${CHILD}.jsonl`);
  mkdirSync(dirname(childFile), { recursive: true });
  return { home, dirs, rootFile, childFile };
}

let clock = Date.parse("2026-10-28T01:00:00.000Z");

export function line(entry: Record<string, unknown>, at = (clock += 1000)): string {
  return JSON.stringify({ id: Math.random().toString(16).slice(2, 10), timestamp: new Date(at).toISOString(), ...entry }) + "\n";
}

export const header = (id: string, parent?: string) => line({ type: "session", version: 3, id, cwd: "/work", parentSession: parent });
export const named = (name: string) => line({ type: "session_info", name });
export const user = (text: string) => line({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
export const assistant = (text: string, call?: { name: string; code: string }) =>
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `thinking about ${text}`, thinkingSignature: "SIG" },
        { type: "text", text },
        ...(call ? [{ type: "toolCall", id: `call-${text.length}`, name: call.name, arguments: { code: call.code } }] : []),
      ],
    },
  });
export const toolResult = (text: string) =>
  line({ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "ipython", content: [{ type: "text", text }], details: { stdout: text }, isError: false } });
export const agentMessage = (from: string, text: string) => line({ type: "custom_message", customType: "agent_message", content: `[agent-message from ${from}]\n\n${text}` });
export const digest = () => line({ type: "custom_message", customType: "harness_digest", content: "[harness-digest]\n\nrepeated state" });

export function write(path: string, ...lines: string[]): void {
  writeFileSync(path, lines.join(""));
}

export function append(path: string, ...lines: string[]): void {
  appendFileSync(path, lines.join(""));
}

export async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

export function getJson(socketPath: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
