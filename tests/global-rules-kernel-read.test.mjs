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
// The chat service's copy of the Mac's files, at <MIRROR_DIR>/<host>/<path on that host> (user-history host-catalogs.ts).
const mirrors = join(home, ".cache/sieun-pi/hosts");
const mac = join(mirrors, "mac", "Users/someone/.prime/agent");
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
  macRootA: join(mac, "sessions", `${A}.jsonl`),
  macMe: join(mac, "session-artifacts", A, "sub-11111111", `${id("c1")}.jsonl`),
  macRootB: join(mac, "sessions", `${B}.jsonl`),
  macJobB: join(mac, "session-artifacts", B, "sub-55555555", `${id("d1")}.jsonl`),
  macCleanRoom: join(mac, "clean-room", "run1", `${id("e1")}.jsonl`),
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

test("a systemd-run unit a job starts gets the same guard as its direct children, so its Python reads only the chat's transcripts", () => {
  // On 10-20 at 21:19Z a subagent of 'd5 cache reads' wrote a scan script and ran it with systemd-run --user ... -E PATH sh -c 'python3 scan.py',
  // as AGENTS.md rule 6 says for a long command. The unit started from the user manager's environment, with no RLM_SESSION_DIR or PYTHONPATH,
  // so its Python never loaded kernel-read.py and read the usage lines of every transcript changed in 24 hours, other chats' included. The fake
  // systemd-run below starts its command the way the user manager does: HOME, a default PATH and only the variables passed with -E.
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "systemd-run"), `#!/usr/bin/env -S python3 -I
import os, sys
args, env = sys.argv[1:], {"HOME": os.environ["HOME"], "PATH": "/usr/local/bin:/usr/bin:/bin"}
while args and args[0].startswith("-"):
    flag = args.pop(0)
    if flag == "--":
        break
    if flag in ("-E", "--setenv") or flag.startswith("--setenv="):
        value = flag.split("=", 1)[1] if flag.startswith("--setenv=") else args.pop(0)
        name, has, given = value.partition("=")
        if has or name in os.environ:
            env[name] = given if has else os.environ[name]
    elif flag in ("-u", "--unit", "-p", "--property"):
        args.pop(0)
os.execvpe(args[0], args, env)
`, { mode: 0o755 });
  const scan = join(root, "scan.py");
  writeFileSync(scan, `import os, sys
for top, dirs, names in sorted(os.walk(sys.argv[1])):
    for name in sorted(names):
        try:
            open(os.path.join(top, name)).readline()
            print(name, "read")
        except PermissionError as error:
            print(name, "refused", type(error).__name__)
`);
  // A guarded kernel running this test has its own unit-env/ on PATH already, after fake-bin, and the guard puts it first only when it is missing.
  const out = join(root, "unit.out");
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("unit scan", lambda: sh(f"systemd-run --user --unit=d5cache-scan --collect --same-dir -E PATH sh -c 'python3 ${scan} {P}/sessions > ${out} 2>&1'"))
attempt("unit tail", lambda: sh(f"systemd-run --user --unit=t2 --collect -E PATH sh -c 'tail -1 {F['rootB']}'"))
attempt("unit own", lambda: sh(f"systemd-run --user -u t3 -E PATH -- tail -1 {F['rootA']}"))
`, { RLM_SESSION_DIR: me, PATH: [bin, ...process.env.PATH.split(":").filter((dir) => !dir.endsWith("global-rules/unit-env"))].join(":") }), ["unit scan ran", "unit tail refused TranscriptRefused True", "unit own ran"]);
  assert.deepEqual(readFileSync(out, "utf8").trim().split("\n"), [`${A}.jsonl read`, `${B}.jsonl refused TranscriptRefused`,
    `${J}.jsonl read`, `${K}.jsonl read`]);
});

test("a shell variable or loop that names another family's transcript is judged like the path itself", () => {
  // On 10-21 at 08:10Z the job 'end vent stale triage' (chat 01a1164b) ran bash("f=~/.prime/agent/sessions/<vent's job>.jsonl; ls -la $f;
  // head -c 1500 $f; tail -c 2500 $f") and read the head and tail of another chat's transcript. resolve() dropped `$f`, since f is not in
  // the environment, so the command named no transcript. A later command that named the path itself was refused.
  assert.deepEqual(kernel(`${ATTEMPT}
attempt("assign", lambda: sh(f"hostname; f=~/.prime/agent/sessions/${B}.jsonl; ls -la $f; head -c 1500 $f; echo; tail -c 2500 $f"))
attempt("export", lambda: sh(f'export T="{F["jobB"]}"; tail -1 "$T"'))
attempt("folder", lambda: sh(f"d={P}/sessions && jq -c .type < $d/${B}.jsonl"))
attempt("braces", lambda: sh(f"S=${B}; tail -1 {P}/sessions/\${{S}}.jsonl"))
attempt("loop", lambda: sh(f"for f in {P}/sessions/*.jsonl; do tail -1 $f; done"))
attempt("inner", lambda: sh(f"bash -c 'f={F['rootB']}; cat $f'"))
attempt("own", lambda: sh(f"f={F['sibling']}; tail -1 $f"))
attempt("list", lambda: sh(f"f={F['rootB']}; ls -la $f; wc -l $f; stat $f > /dev/null"))
attempt("loop list", lambda: sh(f"for f in {P}/sessions/*.jsonl; do wc -l $f; done"))
attempt("board", lambda: sh(f"mkdir -p {P}/browser-chat/boards && b={P}/browser-chat/boards/${A}.json && echo '{{}}' > $b && cat $b"))
attempt("log", lambda: sh(f"l=~/.prime/agent/logs; mkdir -p $l && touch $l/transcript-refusals.jsonl && tail -1 $l/transcript-refusals.jsonl"))
`), ["assign refused TranscriptRefused True", "export refused TranscriptRefused True", "folder refused TranscriptRefused True",
    "braces refused TranscriptRefused True", "loop refused TranscriptRefused True", "inner refused TranscriptRefused True",
    "own ran", "list ran", "loop list ran", "board ran", "log ran"]);
});

test("a host's copy under ~/.cache/sieun-pi/hosts is judged like the same transcript under ~/.prime/agent", () => {
  // On 10-23 at about 13:20Z the job 'd9 stuck steps job liveness 10-23' read the transcripts of two other chats through the Mac's copy
  // under ~/.cache/sieun-pi/hosts/mac after the guard refused the same read under ~/.prime/agent/sessions, since the copy was outside PRIME.
  rmSync(log, { force: true });
  assert.deepEqual(kernel(`${ATTEMPT}
M = ${JSON.stringify(mirrors)}
attempt("open", lambda: open(F["macRootB"]).read())
attempt("path", lambda: Path(F["macJobB"]).read_text())
attempt("tail", lambda: sh(f"tail -1 {F['macRootB']}"))
attempt("jq", lambda: sh(f"jq -c .type {F['macJobB']}"))
attempt("sqlite", lambda: sh(f"sqlite3 :memory: \\"select readfile('{F['macRootB']}')\\""))
attempt("rg copy", lambda: sh(f"rg -l session {M}/mac"))
attempt("rg cache", lambda: sh("rg -l session ~/.cache"))
attempt("rg cwd", lambda: sh(f"cd {M} && rg -l session"))
child = subprocess.run([sys.executable, "-c", f"print(open({F['macRootB']!r}).read())"], capture_output=True, text=True)
print("child", "refused" if "TranscriptRefused" in child.stderr and child.returncode else "ran")
attempt("own", lambda: open(F["macMe"]).read())
attempt("own root", lambda: sh(f"tail -1 {F['macRootA']}"))
attempt("own tree", lambda: sh(f"rg -l session {os.path.dirname(F['macMe'])}"))
attempt("clean room", lambda: open(F["macCleanRoom"]).read())
attempt("ls", lambda: sh(f"ls {M}/mac/Users/someone/.prime/agent/sessions; wc -l {F['macRootB']}"))
`), ["open refused TranscriptRefused True", "path refused TranscriptRefused True", "tail refused TranscriptRefused True", "jq refused TranscriptRefused True",
    "sqlite refused TranscriptRefused True", "rg copy refused TranscriptRefused True", "rg cache refused TranscriptRefused True", "rg cwd refused TranscriptRefused True",
    "child refused", "own ran", "own root ran", "own tree ran", "clean room ran", "ls ran"]);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.every((line) => [B, id("d1")].includes(line.of) && line.path.startsWith(mirrors)), JSON.stringify(lines));
});

test("a subagent named by its id under sessions/ belongs to the root that Prime's rlm-ledger spawned it in", () => {
  // On 10-21 at 16:52Z a root of chat-057a opened sessions/<its direct child's id>.jsonl, the form a root's transcript takes, and the guard
  // refused it as another family's, since only a path under session-artifacts/ named the child's root. Prime keeps each subagent's transcript
  // in its parent's artifact folder and records every spawn, child path included, in rlm-ledger/<hash>.jsonl.
  mkdirSync(join(prime, "rlm-ledger"), { recursive: true });
  const spawn = (parent, child, childId) => JSON.stringify({ v: 1, op: "spawn", at: "2026-10-21T16:40:24.515Z", childId, parent, child, depth: 1, name: childId });
  writeFileSync(join(prime, "rlm-ledger", "0123456789abcdef.jsonl"), `${spawn(files.me, files.child, "sub-33333333")}\n${spawn(files.rootB, files.jobB, "sub-55555555")}\n`);
  const named = (n) => join(prime, "sessions", `${id(n)}.jsonl`);
  const probe = `${ATTEMPT}
def read(label, path):
    try:
        open(path).read()
        print(label, "ran")
    except FileNotFoundError:
        print(label, "missing")
    except PermissionError as error:
        print(label, "refused", type(error).__name__)
`;
  assert.deepEqual(kernel(`${probe}
read("child by id", ${JSON.stringify(named("a1"))})
read("other family's job by id", ${JSON.stringify(named("d1"))})
read("unknown id", ${JSON.stringify(named("99"))})
attempt("tail child by id", lambda: sh(f"tail -1 ${named("a1")} 2>/dev/null || true"))
attempt("tail other job by id", lambda: sh(f"tail -1 ${named("d1")} 2>/dev/null || true"))
`, { RLM_SESSION_DIR: join(prime, "session-artifacts", A) }), ["child by id missing", "other family's job by id refused TranscriptRefused",
    "unknown id refused TranscriptRefused", "tail child by id ran", "tail other job by id refused TranscriptRefused True"]);
});

test("the read, grep and bash tools get the same answer from the tool_call half", async () => {
  const { judgeTool } = await import("../components/global-rules/transcript-guard.ts");
  process.env.PRIME_AGENT_CODING_AGENT_DIR = prime;
  process.env.GLOBAL_RULES_TRANSCRIPT_LOG = join(root, "tool-refusals.jsonl");
  const data = process.env.AGENT_CHAT_DATA_DIR;
  process.env.AGENT_CHAT_DATA_DIR = join(root, "chat");
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.match(judgeTool("read", { path: files.rootB }, home, me) ?? "", /outside this session's family/);
    assert.equal(judgeTool("read", { path: files.sibling }, home, me), undefined);
    assert.equal(judgeTool("read", { path: files.jobK }, home, me), undefined);
    assert.match(judgeTool("grep", { pattern: "x", path: join(prime, "sessions") }, home, me) ?? "", /as a whole/);
    assert.match(judgeTool("bash", { command: `tail -1 ${files.jobB}` }, home, me) ?? "", /agent_observe/);
    assert.equal(judgeTool("bash", { command: `ls ${join(prime, "sessions")}` }, home, me), undefined);
    assert.match(judgeTool("bash", { command: `f=${files.rootB}; head -c 1500 $f` }, home, me) ?? "", /agent_observe/);
    assert.equal(judgeTool("bash", { command: "git status" }, home, me), undefined);
    assert.match(judgeTool("read", { path: files.macRootB }, home, me) ?? "", /outside this session's family/);
    assert.equal(judgeTool("read", { path: files.macMe }, home, me), undefined);
    assert.match(judgeTool("grep", { pattern: "x", path: mirrors }, home, me) ?? "", /as a whole/);
    assert.match(judgeTool("bash", { command: "rg -l x ~/.cache" }, home, me) ?? "", /as a whole/);
    assert.match(judgeTool("bash", { command: `cat ${files.macJobB}` }, home, me) ?? "", /agent_observe/);
    assert.equal(judgeTool("bash", { command: `cat ${files.macRootA}` }, home, me), undefined);
    assert.match(judgeTool("bash", { command: `systemd-run --user --unit=x --collect --same-dir -E PATH sh -c 'cat ${files.rootB}'` }, home, me) ?? "", /agent_observe/);
  } finally {
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    delete process.env.GLOBAL_RULES_TRANSCRIPT_LOG;
    process.env.HOME = realHome;
    if (data === undefined) delete process.env.AGENT_CHAT_DATA_DIR;
    else process.env.AGENT_CHAT_DATA_DIR = data;
  }
});
