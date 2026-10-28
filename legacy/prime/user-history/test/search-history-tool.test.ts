// search_history in every Prime session (packages/pi-history API.md, "Agent tool"). The owner let agents search every chat on 10-28 (board
// todo t113) and kept the transcript guard's raw-read rule. So a job in chat A finds chat B's messages and reads a hit's context through the
// tool, which answers from pi-history's docs table over the socket, while kernel-read.py still refuses the job's own open() of B's file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startServer } from "../../../../packages/pi-history/src/server.ts";
import { makeIndex } from "../../../../packages/pi-history/test/fixture.ts";
import { PRELUDE } from "../../../../packages/sieun-rules/src/kernel-guard.ts";

const A = "01a10001-0000-7000-8000-000000000000";
const JOB = "01a10002-0000-7000-8000-000000000000";
const B = "01a10003-0000-7000-8000-000000000000";
const at = Date.parse("2026-10-23T13:20:00Z");

test("a job in chat A finds chat B's messages and reads around B's hit through search_history, while its own open() of B's file is refused", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "search-history-tool-")));
  const home = join(root, "home");
  const prime = join(home, ".prime", "agent");
  const jobFile = join(prime, "session-artifacts", A, "sub-11111111", `${JOB}.jsonl`);
  const bFile = join(prime, "sessions", `${B}.jsonl`);
  for (const file of [jobFile, bFile, join(prime, "sessions", `${A}.jsonl`)]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"type":"session"}\n');
  }
  const saved = { ...process.env };
  Object.assign(process.env, { PRIME_AGENT_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_CHAT_DATA_DIR: root,
    SIEUN_PI_HOSTS: join(root, "no-hosts.json"), PI_HISTORY_SOCKET: join(root, "history.sock") });
  writeFileSync(join(root, "chat-jobs.json"), JSON.stringify({ jobs: {} }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ box: "us-metal02", peers: join(root, "no-hosts.json"), durableIndexes: [] }));
  makeIndex(join(root, "history.db"), [
    { session: A, name: "frontend bro", path: join(prime, "sessions", `${A}.jsonl`) },
    { session: JOB, root: A, parent: A, depth: 1, name: "relay timeout job", path: jobFile },
    { session: B, name: "crawler VP", path: bFile },
  ], [
    { session: A, at, kind: "user", text: "why did the relay time out?" },
    { session: B, at: at + 1000, kind: "user", text: "check the proxy pool first" },
    { session: B, at: at + 2000, kind: "tool_result", tool: "bash", text: "relay mac did not answer in 15000 ms" },
    { session: B, at: at + 3000, kind: "assistant", text: "the pool is fine, the relay was down" },
  ]).close();
  const history = await startServer({ dbPath: join(root, "history.db"), socket: join(root, "history.sock"), settingsFile: join(root, "settings.json") });
  t.after(async () => { await history.close(); process.env = saved; rmSync(root, { recursive: true, force: true }); });

  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const pi = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(tool.name, tool); }
    : () => undefined });
  const { default: historyExtension } = await import("../extension/index.ts");
  historyExtension(pi as never);
  const tool = tools.get("search_history");
  assert.ok(tool, "the extension registers search_history");
  const ctx = { sessionManager: { getSessionId: () => JOB, getSessionFile: () => jobFile } };

  const found = (await tool.execute("call-1", { query: "relay" }, undefined, undefined, ctx)).content[0]!.text;
  const lines = found.split("\n");
  assert.match(lines[0]!, /^3 of 3 hits, [\d.]+ ms, scope all\.$/);
  assert.match(lines[1]!, /^2026-10-23 13:20Z us-metal02 crawler VP \(01a10003\) assistant: the pool is fine, the relay was down ref=us-metal02:01a10003-[^@]+@\d+#\d+$/);
  assert.match(lines[2]!, /crawler VP \(01a10003\) tool_result \(bash\): relay mac did not answer in 15000 ms/);
  assert.match(lines[3]!, /frontend bro\/relay timeout job|frontend bro \(01a10001\) user/);

  const ref = /ref=(\S+)/.exec(lines[2]!)![1]!;
  const read = (await tool.execute("call-2", { read: ref }, undefined, undefined, ctx)).content[0]!.text;
  assert.deepEqual(read.split("\n").map(line => line.replace(/^(.) \S+ \S+ /, "$1 ")), [
    `us-metal02 crawler VP (${B})`,
    "  owner user: check the proxy pool first",
    "> agent tool_result (bash): relay mac did not answer in 15000 ms",
    "  agent assistant: the pool is fine, the relay was down",
  ]);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PRIME_AGENT_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PYTHONPATH"].includes(key)));
  const kernel = spawnSync("python3", ["-B", "-c", `${PRELUDE}
for path in (${JSON.stringify(jobFile)}, ${JSON.stringify(bFile)}):
    try:
        open(path).read()
        print("ran")
    except PermissionError as error:
        print("refused", type(error).__name__)
`], { env: { ...env, HOME: home, RLM_SESSION_DIR: dirname(jobFile), GLOBAL_RULES_LOG: join(root, "global-rules.log"), GLOBAL_RULES_TRANSCRIPT_LOG: join(root, "refusals.jsonl") },
    encoding: "utf8", cwd: home, timeout: 60_000 });
  assert.equal(kernel.status, 0, kernel.stderr);
  assert.deepEqual(kernel.stdout.trim().split("\n"), ["ran", "refused TranscriptRefused"], "the job reads its own file, and the guard's raw-read rule stands for B's");
});
