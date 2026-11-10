// p725, from 11-09: in the 7 d to 11-09, 251 of 418 touched-test reds in auto-sns-agent were never read, because jobs committed, reported and
// ended their turn before the detached run ended. A job's report now waits for that run and is refused on its red (message-limit-check.py point 11).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const SESSION = "01a1c30a-8304-710c-abe8-26214dd55117";
const ROOT_JOB = "01a1c40b-0000-7000-8000-00000000abcd";

/** A box with a shared auto-sns-agent checkout whose convex-save-check.mjs wait prints `wait-text` and exits with `wait-code`. */
async function box() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "report-tests-gate-")));
  const checkout = join(dir, "auto-sns-agent");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await writeFile(join(checkout, ".git", "agent-shared-checkout"), `${checkout}\n`);
  await mkdir(join(checkout, "scripts", "repo", "agent"), { recursive: true });
  await writeFile(join(checkout, "scripts", "repo", "agent", "convex-save-check.mjs"), [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(join(dir, "waits.log"))}, process.argv.slice(2).join(' ') + '\\n');`,
    `process.stdout.write(readFileSync(${JSON.stringify(join(dir, "wait-text"))}, 'utf8'));`,
    `process.exit(Number(readFileSync(${JSON.stringify(join(dir, "wait-code"))}, 'utf8')));`,
  ].join("\n"));
  await writeFile(join(dir, "rlm.py"), [
    "import json",
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_message.send':",
    "        open('sends.txt', 'a').write(json.dumps(payload) + '\\n')",
    "        return {'deliveryStatus': 'delivered'}",
    "    return {'current': {'sessionId': 'x', 'sessionName': 'tests gate job'}, 'agents': []}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "chat-jobs.json"), JSON.stringify({ jobs: { "tests gate job": { chat: "VP of CI", at: 1 } } }));
  const state = join(checkout, ".cache", "convex-save-check", SESSION);
  return { dir, checkout, state };
}

/** One agent_message send from a kernel of SESSION; a subagent unless `root`. Prints {ok, reply} or {ok: false, error}. */
async function send({ dir, checkout }: { dir: string; checkout: string }, role: string, name: string | null, root = false) {
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, agent_message",
    "async def main():",
    "    try:",
    `        reply = await agent_message.host_request('agent_message.send', {'message': 'done: 1 commit', 'receiver_role': ${JSON.stringify(role)}, 'receiver_name': ${name === null ? "None" : JSON.stringify(name)}})`,
    "        print(json.dumps({'ok': True, 'reply': reply}))",
    "    except Exception as error:",
    "        print(json.dumps({'ok': False, 'error': str(error)}))",
    "asyncio.run(main())",
  ].join("\n");
  const sessionDir = root ? join(dir, "session-artifacts", ROOT_JOB) : join(dir, "session-artifacts", ROOT_JOB, "sub-1234");
  const { stdout } = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, RLM_HARNESS_STATE_DIR: join(sessionDir, "session-artifacts", SESSION, "harness"),
      GLOBAL_RULES_AUTO_SNS_AGENT: checkout, SIEUN_PI_HOSTS: join(dir, "no-hosts.json"), PI_HOST_SOCKET: join(dir, "no-pi-host.sock"),
      PI_AGENT_BUS_BOXES: join(dir, "no-boxes.json"), CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", PI_HOST_SESSION_ID: "" } });
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; reply?: Record<string, unknown>; error?: string };
}

const sends = async (dir: string) => (await readFile(join(dir, "sends.txt"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const waits = async (dir: string) => (await readFile(join(dir, "waits.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);

test("a job's report waits for its touched tests, is refused on their red, and goes out with a note on a pass or a timeout", async () => {
  const b = await box();
  assert.deepEqual(await send(b, "parent", null), { ok: true, reply: { deliveryStatus: "delivered" } }, "a session that queued nothing sends at once");
  assert.deepEqual(await waits(b.dir), [], "and runs no wait");
  await mkdir(b.state, { recursive: true });
  await writeFile(join(b.state, "queue"), "tests\tabc1234567\tscripts/ci/x.mjs\n");
  await writeFile(join(b.dir, "wait-text"), "touched tests: your commit abc1234567 breaks the unit tests its files touch\n  scripts/ci/x.test.mjs");
  await writeFile(join(b.dir, "wait-code"), "1");
  const red = await send(b, "parent", null);
  assert.equal(red.ok, false);
  assert.match(red.error!, /^agent_message: not sent\. The touched tests of your own commits are red[\s\S]*abc1234567 breaks[\s\S]*scripts\/ci\/x\.test\.mjs/);
  assert.equal(await sends(b.dir), 1, "the refused report never reaches the daemon");
  assert.deepEqual(await waits(b.dir), [`wait --root ${b.checkout} --session ${SESSION}`]);
  const chat = await send(b, "sibling", "VP of CI", true);
  assert.equal(chat.ok, false, "a create_session job's report to the chat chat-jobs.json files it under is refused too");
  const other = await send(b, "sibling", "VP of CI");
  assert.equal(other.ok, true, "a subagent's message to a sibling is no report and goes out");
  assert.equal((await waits(b.dir)).length, 2, "and runs no wait");
  await writeFile(join(b.dir, "wait-text"), "touched tests: the unit tests of your commit def7654321 pass again at 2026-11-10T02:00:00.000Z.");
  await writeFile(join(b.dir, "wait-code"), "0");
  const green = await send(b, "parent", null);
  assert.equal(green.reply?.deliveryStatus, "delivered");
  assert.match(String(green.reply?.note), /def7654321 pass again/);
  await writeFile(join(b.dir, "wait-text"), "touched tests: the unit tests of your commit fed1234567 still run after 900 s, so CI judges them.");
  await writeFile(join(b.dir, "wait-code"), "3");
  const late = await send(b, "parent", null);
  assert.equal(late.reply?.deliveryStatus, "delivered");
  assert.match(String(late.reply?.note), /still run after 900 s, so CI judges them\. This report went out before their verdict\./);
  assert.equal(await sends(b.dir), 4);
});
