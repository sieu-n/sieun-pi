// On 10-24 carried-wait release-run-1's collect judged with the dc76a413 judge it had loaded at start, wrote release-run-1.pass.md and deleted
// its run folder, after later judge fixes had landed. So a collect whose loaded judge is older than the current one judges through a fresh
// process of the current code, writes an open result when that cannot run, and teardown archives the inputs, which rejudge reads again.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const HERE = join(import.meta.dirname, "..");
const JUDGE_HEAD = /^export function judge\(run: string, state: RunState, now = Date\.now\(\)[^\n]*\{$/m;
const OLD_JUDGE = `\n  return { verdict: "pass", text: "# old judge: pass\\n" };`;
const NEW_JUDGE = `\n  return { verdict: "fail", text: \`# Clean-room run \${run.split("/").at(-1)}: fail\\n\\nnew judge read \${files(join(run, "agents")).length} agents snapshots ` +
  "and ${readSession(state.chat.id, [state.chat.id]).length} chat events, window end ${new Date(now).toISOString()}\\n` };";

/** A copy of this package's clean-room scripts, with links to the rest, that a test can change while a collect of it runs. */
/** The body goes first in carried-wait.ts's judge, so it returns before the real judge runs. */
function codeCopy(root: string): { dir: string; judge(body: string): void } {
  const dir = join(root, "code", "components", "user-history");
  cpSync(join(HERE, "scripts/clean-room"), join(dir, "scripts/clean-room"), { recursive: true });
  for (const part of ["src", "node_modules", "package.json", "tsconfig.json"]) symlinkSync(join(HERE, part), join(dir, part));
  const file = join(dir, "scripts/clean-room/carried-wait.ts");
  const original = readFileSync(file, "utf8");
  assert.match(original, JUDGE_HEAD);
  return { dir, judge: body => writeFileSync(file, original.replace(JUDGE_HEAD, head => head + body)) };
}

async function trial(changeTo: string): Promise<{ root: string; record: string; code: ReturnType<typeof codeCopy>; env: NodeJS.ProcessEnv; until: string; close(): Promise<void> }> {
  const srv = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(request.method === "GET" ? JSON.stringify({ agents: [{ sessionId: "job-1", key: "child:job-1", name: "disk sampler", state: "working", link: "subagent" }] }) : "{}");
    });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "clean-room-judge-version-"));
  const record = join(root, "clean-room", "carried-wait");
  const run = join(record, "release-run-1");
  const data = join(root, "data"), sessions = join(root, ".prime/agent/sessions");
  for (const dir of [run, join(data, "boards"), sessions]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, "configuration.json"), JSON.stringify({ csrfToken: "abc123", port: (srv.address() as AddressInfo).port, capability: "cap" }));
  writeFileSync(join(data, "check-in-settings.json"), "{}");
  writeFileSync(join(data, "service.log"), "delivery sibling send: from session job-1 (disk sampler) of chat chat-1 to session chat-1 as m-1\n");
  const line = (at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
  writeFileSync(join(sessions, "chat-1.jsonl"), [line("2026-10-24T09:00:00.000Z", "the disk sampler job is sampling"), line("2026-10-24T09:10:00.000Z", "how is it going")].join("\n") + "\n");
  writeFileSync(join(run, "criteria.md"), "a. a scheduled check-in runs on a wait over 2 h old\n");
  writeFileSync(join(run, "run.json"), JSON.stringify({ scenario: "carried-release", chat: { id: "chat-1", name: "disk trend" }, fixtures: { "disk sampler": "job-1" }, sandbox: root,
    everyMs: 900_000, release: "release-test", board: "", seeds: [], setupAt: 0, windowStart: 0 }));
  const code = codeCopy(root);
  code.judge(OLD_JUDGE);
  const env = { ...process.env, HOME: root, AGENT_CHAT_DATA_DIR: data, CLEAN_ROOM_SESSION: "", SIEUN_PI_HOSTS: join(root, "no-hosts.json") };
  // measured: clean-room.ts took 4.6 s to load under tsx on us-metal02 on 10-24, so the window ends after the collect starts and the judge changes.
  const until = new Date(Date.now() + 20_000).toISOString();
  const collect = spawn(process.execPath, ["--import", "tsx", join(code.dir, "scripts/clean-room/clean-room.ts"), "collect", "--run", run, "--until", until, "--every-s", "1"],
    { cwd: code.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  collect.stdout.on("data", chunk => { output += chunk; });
  collect.stderr.on("data", chunk => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    collect.stdout.on("data", () => { if (output.includes("collect until")) resolve(); });
    collect.once("exit", code => reject(new Error(`collect exited ${code} before it started: ${output}`)));
  });
  code.judge(changeTo);
  const exit = await new Promise<number | null>(resolve => collect.once("exit", resolve));
  assert.equal(exit, 0, output);
  return { root, record, code, env, until, close: () => new Promise<void>((resolve, reject) => srv.close(error => error ? reject(error) : resolve())) };
}

const rejudge = async (code: { dir: string }, env: NodeJS.ProcessEnv, archive: string): Promise<string> =>
  (await promisify(execFile)(process.execPath, ["--import", "tsx", join(code.dir, "scripts/clean-room/clean-room.ts"), "rejudge", "--archive", archive], { cwd: code.dir, env })).stdout;

test("a judge that changes while collect runs judges the run, and rejudge reads the archived inputs after cleanup", async () => {
  const { root, record, code, env, until, close } = await trial(NEW_JUDGE);
  try {
    assert.ok(!existsSync(join(record, "release-run-1.pass.md")), "the loaded judge's pass is not published");
    const verdict = readFileSync(join(record, "release-run-1.fail.md"), "utf8");
    assert.match(verdict, /new judge read [1-9]\d* agents snapshots and 2 chat events/);
    assert.match(verdict, /in a fresh process, since the process that asked had loaded the older/);
    assert.ok(!existsSync(join(record, "release-run-1")), "the run folder is deleted");
    const archive = join(record, "release-run-1.evidence.tar.gz");
    assert.ok(existsSync(archive));
    rmSync(join(root, ".prime"), { recursive: true, force: true });

    const out = await rejudge(code, env, archive);
    const file = readdirSync(record).find(name => name.startsWith("release-run-1.rejudged-") && name.endsWith(".fail.md"));
    assert.ok(file, out);
    const again = readFileSync(join(record, file), "utf8");
    assert.match(again, /new judge read [1-9]\d* agents snapshots and 2 chat events/);
    assert.ok(again.includes(`window end ${new Date(until).toISOString()}`), again);
    assert.ok(again.includes(join(record, "release-run-1")), "the text names the original run folder");
    assert.ok(!readdirSync(record).some(name => name.includes(".rejudge-")), "rejudge deletes its unpacked copy");

    const list = (await promisify(execFile)("tar", ["-tzf", archive])).stdout;
    for (const entry of ["./archive.json", "./identity.jsonl", "./ownership.json", "./release-run-1/criteria.md", "./home/.prime/agent/sessions/chat-1.jsonl", "./verdicts/release-run-1.fail.md"])
      assert.ok(list.split("\n").includes(entry), `${entry} in ${list}`);
    const identity = (await promisify(execFile)("tar", ["-xOzf", archive, "./identity.jsonl"])).stdout;
    assert.deepEqual(identity.trim().split("\n").map(line => { const { line: _, ...record } = JSON.parse(line) as Record<string, string>; return record; }),
      [{ path: "sibling send", from: "job-1", fromName: "disk sampler", fromChat: "chat-1", to: "chat-1", id: "m-1" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await close();
  }
});

test("a current judge that cannot run leaves an open result that points at the archive, and rejudge judges it once fixed", async () => {
  const { root, record, code, env, close } = await trial("\n  return {{ broken");
  try {
    assert.ok(!existsSync(join(record, "release-run-1.pass.md")), "the loaded judge's pass is not published");
    const open = readFileSync(join(record, "release-run-1.open.md"), "utf8");
    assert.match(open, /could not run/);
    assert.ok(open.includes("clean-room.ts rejudge --archive " + join(record, "release-run-1.evidence.tar.gz")), open);
    assert.ok(!existsSync(join(record, "release-run-1")), "the run folder is deleted at its window end");

    code.judge(NEW_JUDGE);
    await rejudge(code, env, join(record, "release-run-1.evidence.tar.gz"));
    assert.ok(readdirSync(record).some(name => name.startsWith("release-run-1.rejudged-") && name.endsWith(".fail.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    await close();
  }
});
