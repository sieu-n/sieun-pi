import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PiHost } from "../../host/src/host.ts";
import type { HostedSession } from "../../host/src/session.ts";
import piRlm from "../../rlm/index.ts";
import { testPython } from "../../rlm/test/helpers.ts";
import scripted from "../rig/scripted.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

const COMPONENTS = resolve(import.meta.dirname, "../../..");
let root: string;
let host: PiHost;
let chat: HostedSession;
let other: HostedSession;
const ws = () => join(root, "ws");

before(async () => {
  await testPython();
  root = mkdtempSync(join(tmpdir(), "rules-port-ext-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(ws(), ".claude", "rules"), { recursive: true });
  mkdirSync(join(ws(), "src"), { recursive: true });
  writeFileSync(join(ws(), ".claude", "rules", "always.md"), "RULES-TEST-ALWAYS\n");
  writeFileSync(join(ws(), ".claude", "rules", "scoped.md"), "---\npaths: 'src/**'\n---\nRULES-TEST-SCOPED\n");
  writeFileSync(join(ws(), "src", "a.ts"), "export const a = 1;\n");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
  process.env.GLOBAL_RULES_TRANSCRIPT_LOG = join(root, "transcript-refusals.jsonl");
  process.env.SIEUN_PI_HOSTS = join(root, "no-hosts.json");
  process.env.RULES_RIG_CONTEXT = join(root, "context.jsonl");
  // A test started from a Prime kernel carries that kernel's guard on PYTHONPATH and its agent dir and harness stores, which name live files.
  for (const key of Object.keys(process.env)) if (/^(RLM_|PRIME_AGENT_)|^PYTHONPATH$/.test(key)) delete process.env[key];
  host = new PiHost({
    agentDir, defaultCwd: ws(), defaultModel: { provider: "script", id: "m" }, extensionFactories: [scripted, piRlm],
    extensions: ["global-rules/index.ts", "claude-rules/index.ts", "user-history/extension/index.ts"].map(path => join(COMPONENTS, path)),
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, log: () => {},
  });
  chat = await host.openSession({ cwd: ws(), extensionFlagValues: { chat: true } });
  other = await host.openSession({ cwd: ws() });
});

after(async () => {
  await host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

type Part = { type: string; text?: string };
async function call(session: HostedSession, name: string, args: Record<string, unknown>): Promise<string> {
  const before = session.session.messages.length;
  await session.session.prompt(`TOOL ${JSON.stringify({ name, arguments: args })}`);
  await session.session.waitForIdle();
  const result = session.session.messages.slice(before).find(m => m.role === "toolResult") as { content: Part[] } | undefined;
  assert.ok(result, `no tool result for ${name}`);
  return result.content.map(p => p.text ?? "").join("");
}

test("the kernel guards load into pi-rlm's kernel with the session's own folder", async () => {
  const text = await call(chat, "ipython", { code: "import sys, os\nprint(sys.global_rules_send_guard, sys.global_rules_kernel_read, sys.global_rules_kernel_own, os.environ['RLM_SESSION_DIR'])" });
  assert.match(text, new RegExp(`True True True .*session-artifacts/${chat.id}`));
});

test("a read of another Pi root's transcript is refused, by the read tool and in the kernel", async () => {
  const theirs = other.session.sessionManager.getSessionFile()!;
  assert.match(await call(chat, "read", { path: theirs, limit: 1 }), /global-rules refused reading/);
  assert.match(await call(chat, "ipython", { code: `open(${JSON.stringify(theirs)}).close()` }), /TranscriptRefused/);
  assert.match(await call(chat, "read", { path: chat.session.sessionManager.getSessionFile()!, limit: 1 }), /"type":"session"/);
});

test("a send is refused without OWNER_OK and a cap is refused", async () => {
  assert.match(await call(chat, "bash", { command: "mail -s hi bob@example.com < /dev/null" }), /send guard: refused/);
  assert.match(await call(chat, "ipython", { code: "import subprocess\nc = 'ma' + 'il'\nsubprocess.run([c, '-s', 'hi', 'bob@example.com'], stdin=subprocess.DEVNULL)" }), /send guard/);
  assert.match(await call(chat, "bash", { command: "nice -n 10 true" }), /cap guard/);
  const sends = readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { decision: string; chat: string });
  assert.ok(sends.some(s => s.decision === "refused" && s.chat === chat.id), JSON.stringify(sends));
});

test("claude-rules puts the unscoped rule first in every request and the scoped one on a read under src/", async () => {
  assert.match(await call(chat, "read", { path: join(ws(), "src", "a.ts") }), /RULES-TEST-SCOPED/);
  const requests = readFileSync(join(root, "context.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { messages: { role: string; text: string }[] });
  assert.ok(requests.length > 0);
  for (const request of requests) assert.match(request.messages.find(m => m.role !== "system")?.text ?? "", /RULES-TEST-ALWAYS/);
});

test("chat_board writes and reads the chat's board in the Pi agent dir", async () => {
  assert.match(await call(chat, "chat_board", { ops: [{ op: "plan_add", text: "rules port test step" }] }), /added p\w+ "rules port test step"/i);
  assert.match(await call(chat, "chat_board", {}), /rules port test step/);
  assert.ok(existsSync(join(root, "agent", "browser-chat", "boards", `${chat.id}.json`)));
});
