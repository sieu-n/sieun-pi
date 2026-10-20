import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// On 10-19 (runtime intent trace) and on 10-20 from 15:59Z to 16:10Z (p8-prepare-hold) jobs of chat-057a opened the transcripts of unrelated
// roots under ~/.prime/agent/sessions to read their state lines, and the scope reminder in their brief came too late. kernel-read.py lets a
// session read only its own chat's transcripts: the chat's root tree and the trees of the root jobs the chat started (chat-jobs.json).
const { PRELUDE } = await import("../components/global-rules/kernel-guard.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kernel-read-")));
const home = join(root, "home");
const prime = join(home, ".prime/agent");
const A = "01a1000a-0000-7000-8000-00000000000a";
const B = "01a1000b-0000-7000-8000-00000000000b";
const J = "01a1000d-0000-7000-8000-00000000000d";
const K = "01a1000e-0000-7000-8000-00000000000e";
const id = (n) => `01a10000-0000-7000-8000-0000000000${n}`;
const files = {
  rootA: join(prime, "sessions", `${A}.jsonl`),
  me: join(prime, "session-artifacts", A, "sub-11111111", `${id("c1")}.jsonl`),
  child: join(prime, "session-artifacts", A, "sub-11111111", "sub-33333333", `${id("a1")}.jsonl`),
  sibling: join(prime, "session-artifacts", A, "sub-22222222", `${id("c2")}.jsonl`),
  nephew: join(prime, "session-artifacts", A, "sub-22222222", "sub-44444444", `${id("b1")}.jsonl`),
  rootB: join(prime, "sessions", `${B}.jsonl`),
  jobB: join(prime, "session-artifacts", B, "sub-55555555", `${id("d1")}.jsonl`),
  copyB: join(prime, "backups", "restore-1", "sessions", `${B}.jsonl`),
  copyA: join(prime, "backups", "restore-1", "sessions", `${A}.jsonl`),
  cleanRoom: join(prime, "clean-room", "run1", `${id("e1")}.jsonl`),
  jobJ: join(prime, "sessions", `${J}.jsonl`),
  jobK: join(prime, "sessions", `${K}.jsonl`),
  jobKChild: join(prime, "session-artifacts", K, "sub-66666666", `${id("f1")}.jsonl`),
};
for (const [name, file] of Object.entries(files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `{"type":"session","id":"${name}"}\n`);
}
writeFileSync(join(prime, "session-artifacts", A, "sub-11111111", "semantic-edges.jsonl"), "{}\n");
// J is a duty job the chat A started (filed by id), K a root job it started with rlm.create_session (filed by its session name).
writeFileSync(files.jobK, `{"type":"session","id":"${K}"}\n{"type":"session_info","id":"ab12cd34","parentId":null,"name":"nightly look"}\n`);
mkdirSync(join(root, "chat"), { recursive: true });
writeFileSync(join(root, "chat", "chat-jobs.json"), JSON.stringify({ jobs: { [J]: { chat: "chat A", at: 1, chatId: A }, "nightly look": { chat: "chat A", at: 1, chatId: A },
  "other job": { chat: "chat B", at: 1, chatId: B } } }));
const me = dirname(files.me);
mkdirSync(join(prime, "skills", "catalog"), { recursive: true });
writeFileSync(join(prime, "skills", "catalog", "reader.py"), "def first(path):\n    with open(path) as handle:\n        return handle.readline()\n");
const log = join(prime, "logs", "transcript-refusals.jsonl");
test.after(() => rmSync(root, { recursive: true, force: true }));

const env = (extra) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["RLM_SESSION_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PYTHONPATH", "OWNER_OK", "GLOBAL_RULES_TRANSCRIPT_LOG"].includes(key)));
  return { ...base, HOME: home, GLOBAL_RULES_LOG: join(root, "global-rules.log"), AGENT_CHAT_DATA_DIR: join(root, "chat"), ...extra };
};
const kernel = (code, extra = { RLM_SESSION_DIR: me }) => {
  const run = spawnSync("python3", ["-B", "-c", `${PRELUDE}${code}`], { env: env(extra), encoding: "utf8", cwd: home, timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split("\n").map((line) => line.trim());
};
const ATTEMPT = `
import json, os, subprocess, sys
from pathlib import Path
F = ${JSON.stringify(files)}
P = ${JSON.stringify(prime)}
def attempt(label, call):
    try:
        out = call()
        print(label, "ran")
    except PermissionError as error:
        print(label, "refused", type(error).__name__, "agent_observe.list_agents()" in str(error))
def sh(command):
    run = subprocess.run(["bash", "-c", command], capture_output=True, text=True, cwd=os.path.expanduser("~"))
    if run.returncode:
        raise RuntimeError(run.stderr)
    return run.stdout
`;

test("a job reads its own chat's transcripts, root jobs the chat started included, and lists or counts any session", () => {
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("own", lambda: open(F["me"]).read())
attempt("root", lambda: Path(F["rootA"]).read_text())
attempt("sibling", lambda: json.loads(open(F["sibling"]).readline()))
attempt("child", lambda: open(F["child"], "rb").read())
attempt("root copy", lambda: open(F["copyA"]).read())
attempt("edges", lambda: open(os.path.join(os.path.dirname(F["me"]), "semantic-edges.jsonl")).read())
attempt("clean room", lambda: open(F["cleanRoom"]).read())
attempt("listdir", lambda: os.listdir(P + "/sessions"))
attempt("ls", lambda: sh(f"ls {P}/sessions | wc -l"))
attempt("wc", lambda: sh(f"wc -l {F['rootB']}"))
attempt("find", lambda: sh(f"find {P}/sessions {P}/session-artifacts -name '*.jsonl' | wc -l"))
attempt("rg own", lambda: sh(f"rg -l session {os.path.dirname(F['me'])} || true"))
attempt("tail sibling", lambda: sh(f"tail -1 {F['sibling']}"))
attempt("nephew", lambda: open(F["nephew"]).read())
attempt("duty job", lambda: open(F["jobJ"]).read())
attempt("root job", lambda: open(F["jobK"]).read())
attempt("root job child", lambda: open(F["jobKChild"]).read())
attempt("rg chat tree", lambda: sh(f"rg -l session {P}/session-artifacts/${A} || true"))
sys.path.insert(0, P + "/skills/catalog")
import reader
attempt("catalog tool", lambda: reader.first(F["rootB"]))
`), ["own ran", "root ran", "sibling ran", "child ran", "root copy ran", "edges ran", "clean room ran", "listdir ran", "ls ran", "wc ran", "find ran",
    "rg own ran", "tail sibling ran", "nephew ran", "duty job ran", "root job ran", "root job child ran", "rg chat tree ran", "catalog tool ran"]);
});

test("a job's reads of another family's transcripts are refused in Python, in commands and in Python processes it starts", () => {
  rmSync(log, { force: true });
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("open", lambda: open(F["rootB"]).read())
attempt("path", lambda: Path(F["jobB"]).read_text())
attempt("os.open", lambda: os.read(os.open(F["rootB"], os.O_RDONLY), 10))
attempt("copy", lambda: open(F["copyB"]).read())
attempt("tail", lambda: sh(f"tail -n 5 {F['rootB']}"))
attempt("jq", lambda: sh(f"cd {P}/sessions && jq -c .type < ${B}.jsonl"))
attempt("rg wide", lambda: sh(f"rg -l -i 'prepare' {P}/sessions"))
attempt("rg cwd", lambda: sh(f"cd {P}/session-artifacts && rg -l prepare"))
attempt("xargs", lambda: sh(f"cd {P} && find sessions session-artifacts -name '*.jsonl' -print0 | xargs -0 rg -l -i prepare"))
attempt("exec", lambda: sh(f"find {P}/session-artifacts/${B} -name '*.jsonl' -exec tail -1 {{}} +"))
attempt("glob", lambda: sh(f"tail -q -n 1 {P}/sessions/*.jsonl"))
attempt("grep -r", lambda: sh(f"grep -rl prepare {P}"))
attempt("cp", lambda: sh(f"cp {F['jobB']} /tmp/extract.jsonl"))
attempt("system", lambda: (_ for _ in ()).throw(PermissionError("refused agent_observe.list_agents()")) if os.system(f"cat {F['rootB']} > /dev/null") else None)
child = subprocess.run([sys.executable, "-c", f"print(open({F['rootB']!r}).read())"], capture_output=True, text=True)
print("child", "refused" if "TranscriptRefused" in child.stderr and child.returncode else "ran")
`), ["open refused TranscriptRefused True", "path refused TranscriptRefused True", "os.open refused TranscriptRefused True",
    "copy refused TranscriptRefused True", "tail refused TranscriptRefused True",
    "jq refused TranscriptRefused True", "rg wide refused TranscriptRefused True", "rg cwd refused TranscriptRefused True",
    "xargs refused TranscriptRefused True", "exec refused TranscriptRefused True", "glob refused TranscriptRefused True",
    "grep -r refused TranscriptRefused True", "cp refused TranscriptRefused True", "system refused TranscriptRefused True", "child refused"]);
  assert.ok(!existsSync("/tmp/extract.jsonl") || readFileSync("/tmp/extract.jsonl", "utf8") !== `{"type":"session","id":"jobB"}\n`);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length >= 14, `${lines.length} refusal lines`);
  assert.deepEqual([...new Set(lines.map((line) => line.session))], [me]);
  assert.ok(lines.every((line) => [B, id("d1")].includes(line.of)), JSON.stringify(lines.map((line) => line.of)));
});

test("a root job the chat started reads the chat's transcripts, and a root job of another chat reads none of them", () => {
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("chat", lambda: open(F["rootA"]).read())
attempt("chat job", lambda: open(F["me"]).read())
attempt("other root job", lambda: open(F["jobJ"]).read())
attempt("rootB", lambda: open(F["rootB"]).read())
`, { RLM_SESSION_DIR: join(prime, "session-artifacts", K) }), ["chat ran", "chat job ran", "other root job ran", "rootB refused TranscriptRefused True"]);
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("chat A", lambda: open(F["rootA"]).read())
attempt("chat B", lambda: open(F["jobB"]).read())
`, { RLM_SESSION_DIR: join(prime, "session-artifacts", B, "sub-55555555") }), ["chat A refused TranscriptRefused True", "chat B ran"]);
});

test("a root reads its own tree and nothing of another root, and with no RLM_SESSION_DIR nothing is judged", () => {
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("nephew", lambda: open(F["nephew"]).read())
attempt("rootA", lambda: open(F["rootA"]).read())
attempt("root job", lambda: open(F["jobKChild"]).read())
attempt("rootB", lambda: open(F["rootB"]).read())
`, { RLM_SESSION_DIR: join(prime, "session-artifacts", A) }), ["nephew ran", "rootA ran", "root job ran", "rootB refused TranscriptRefused True"]);
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("rootB", lambda: open(F["rootB"]).read())
attempt("rg wide", lambda: sh(f"rg -l -i 'prepare' {P}/sessions || true"))
`, {}), ["rootB ran", "rg wide ran"]);
});

test("the read, grep and bash tools get the same answer from the tool_call half", async () => {
  const { judgeTool } = await import("../components/global-rules/transcript-guard.ts");
  process.env.PRIME_AGENT_CODING_AGENT_DIR = prime;
  process.env.GLOBAL_RULES_TRANSCRIPT_LOG = join(root, "tool-refusals.jsonl");
  const data = process.env.AGENT_CHAT_DATA_DIR;
  process.env.AGENT_CHAT_DATA_DIR = join(root, "chat");
  try {
    assert.match(judgeTool("read", { path: files.rootB }, home, me) ?? "", /outside this session's family/);
    assert.equal(judgeTool("read", { path: files.sibling }, home, me), undefined);
    assert.equal(judgeTool("read", { path: files.jobK }, home, me), undefined);
    assert.match(judgeTool("grep", { pattern: "x", path: join(prime, "sessions") }, home, me) ?? "", /as a whole/);
    assert.match(judgeTool("bash", { command: `tail -1 ${files.jobB}` }, home, me) ?? "", /agent_observe/);
    assert.equal(judgeTool("bash", { command: `ls ${join(prime, "sessions")}` }, home, me), undefined);
    assert.equal(judgeTool("bash", { command: "git status" }, home, me), undefined);
  } finally {
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    delete process.env.GLOBAL_RULES_TRANSCRIPT_LOG;
    if (data === undefined) delete process.env.AGENT_CHAT_DATA_DIR;
    else process.env.AGENT_CHAT_DATA_DIR = data;
  }
});
