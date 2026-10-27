import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { agentDir, piAgentDir, piTranscriptId, sessionDirOf } from "../../../components/global-rules/paths.ts";
import { sendLogPath, sessionOf } from "../../../components/global-rules/send-log.ts";

const ROOT = "01a17c4b-9751-713e-9b70-3ab8c5d03cf5";
const OTHER = "01a0cc5e-0ca4-762a-90e6-566c310bd50a";
const CHILD = "01a17c4b-a2f7-713e-9b70-3abc0a27165f";
const tmp = mkdtempSync(join(tmpdir(), "rules-port-paths-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("sessionDirOf keeps Prime's layout and finds pi-rlm's folder for a Pi transcript", () => {
  assert.equal(sessionDirOf(`/h/.prime/agent/sessions/${ROOT}.jsonl`), `/h/.prime/agent/session-artifacts/${ROOT}`);
  assert.equal(sessionDirOf(`/h/.prime/agent/session-artifacts/${ROOT}/sub-1f2ec251/${CHILD}.jsonl`), `/h/.prime/agent/session-artifacts/${ROOT}/sub-1f2ec251`);
  assert.equal(sessionDirOf(`/h/elsewhere/${ROOT}.jsonl`), null);
  assert.equal(sessionDirOf(undefined), null);
  const env = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/h/pi-agent";
  try {
    assert.equal(sessionDirOf(`/h/pi-agent/sessions/--h-ws--/2026-10-27T07-38-14-135Z_${ROOT}.jsonl`), `/h/pi-agent/session-artifacts/${ROOT}`);
    assert.equal(sessionDirOf(`/h/host-sessions/2026-10-27T07-38-14-135Z_${ROOT}.jsonl`, ROOT), `/h/pi-agent/session-artifacts/${ROOT}`);
    assert.equal(sessionDirOf(`/h/pi-agent/session-artifacts/${ROOT}/sub-468a4903/2026-10-27T07-38-14-135Z_${CHILD}.jsonl`), `/h/pi-agent/session-artifacts/${ROOT}/sub-468a4903`);
  } finally {
    if (env === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = env;
  }
  assert.equal(piTranscriptId(`2026-10-27T07-38-14-135Z_${ROOT}.jsonl`), ROOT);
  assert.equal(piTranscriptId(`${ROOT}.jsonl`), null);
});

test("the agent dir is Prime's unless only Pi's is named", () => {
  assert.equal(agentDir({ HOME: "/h" }).endsWith(join(".prime", "agent")), true);
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/pi" }), "/pi");
  assert.equal(agentDir({ PRIME_AGENT_CODING_AGENT_DIR: "/prime", PI_CODING_AGENT_DIR: "/pi" }), "/prime");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/pi" }), "/pi");
  assert.equal(sendLogPath({ PI_CODING_AGENT_DIR: "/pi" }), "/pi/browser-chat/sends.jsonl");
});

test("the send log names a Pi transcript by its id, and Prime's paths as before", () => {
  assert.deepEqual(sessionOf(`/h/.prime/agent/sessions/${ROOT}.jsonl`), { chat: ROOT, session: ROOT });
  assert.deepEqual(sessionOf(`/h/.prime/agent/session-artifacts/${ROOT}/sub-1f2ec251/${CHILD}.jsonl`), { chat: ROOT, session: `${ROOT}/sub-1f2ec251/${CHILD}` });
  assert.deepEqual(sessionOf(`/h/pi/sessions/--h-ws--/2026-10-27T07-38-14-135Z_${ROOT}.jsonl`), { chat: ROOT, session: ROOT });
  assert.deepEqual(sessionOf(`/h/pi/session-artifacts/${ROOT}/sub-468a4903/2026-10-27T07-38-14-135Z_${CHILD}.jsonl`), { chat: ROOT, session: `${ROOT}/sub-468a4903/${CHILD}` });
});

/** kernel-read.py's tool_call judge, run as transcript-guard.ts runs it, in a fake home with a Prime agent dir and a Pi agent dir. */
function judge(home: string, piDir: string, session: string, path: string): string | null {
  const script = resolve(import.meta.dirname, "../../../components/global-rules/kernel-read.py");
  const run = spawnSync("python3", ["-B", script, "--judge"], {
    input: JSON.stringify({ tool: "read", path, cwd: home, session }), encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: piDir, RLM_SESSION_DIR: session, PYTHONPATH: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  return (JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { refuse: string | null }).refuse;
}

test("a Pi session's kernel guard refuses another family's transcript in Prime's and Pi's agent dirs", () => {
  const home = join(tmp, "home");
  const prime = join(home, ".prime", "agent");
  const pi = join(tmp, "pi-agent");
  mkdirSync(join(prime, "sessions"), { recursive: true });
  mkdirSync(join(pi, "sessions", "--ws--"), { recursive: true });
  mkdirSync(join(pi, "session-artifacts", ROOT), { recursive: true });
  const primeOther = join(prime, "sessions", `${OTHER}.jsonl`);
  const piOther = join(pi, "sessions", "--ws--", `2026-10-27T07-00-00-000Z_${OTHER}.jsonl`);
  const piOwn = join(pi, "sessions", "--ws--", `2026-10-27T07-38-14-135Z_${ROOT}.jsonl`);
  for (const file of [primeOther, piOther, piOwn]) writeFileSync(file, "{}\n");
  const session = join(pi, "session-artifacts", ROOT);
  assert.match(judge(home, pi, session, primeOther) ?? "", /global-rules refused reading/);
  assert.match(judge(home, pi, session, piOther) ?? "", /global-rules refused reading/);
  assert.equal(judge(home, pi, session, piOwn), null);
});
