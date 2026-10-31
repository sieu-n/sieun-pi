import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// On 10-22 at 02:16:45Z a job started a scratch Prime daemon with systemd-run --user ... -E HOME=<scratch> sh -c 'prime-agent --mode daemon
// --daemon-socket <scratch>/d.sock'. unit-env/systemd-run passed the kernel's PRIME_AGENT_CODING_AGENT_DIR=~/.prime/agent with -E, and the
// daemon wrote a session, a lease, a worker folder and two logs into the live agent dir.
const wrapper = join(dirname(fileURLToPath(import.meta.url)), "../packages/sieun-rules/src/unit-env/systemd-run");
const root = realpathSync(mkdtempSync(join(tmpdir(), "unit-env-scratch-")));
test.after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const live = join(home, ".prime/agent");
mkdirSync(live, { recursive: true });
const bin = join(root, "real-bin");
mkdirSync(bin);
writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });

const run = (args) => {
  const ran = spawnSync("sh", [wrapper, ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, RLM_SESSION_DIR: join(live, "session-artifacts/x"), PRIME_AGENT_CODING_AGENT_DIR: live },
  });
  return { code: ran.status, args: ran.stdout.trim().split("\n").filter(Boolean), err: ran.stderr };
};
const unit = ["--user", "--unit=t", "--collect", "-E", "PATH"];
const scratch = join(root, "scratch");

test("a scratch daemon unit with no agent dir of its own is refused, since it would use the live one", () => {
  const ran = run([...unit, "-E", `HOME=${scratch}/home`, "sh", "-c", `prime-agent --mode daemon --daemon-socket ${scratch}/tmp/d.sock --offline`]);
  assert.equal(ran.code, 2);
  assert.deepEqual(ran.args, []);
  assert.match(ran.err, /needs its own PRIME_AGENT_CODING_AGENT_DIR/);
});

test("a scratch daemon unit that names an agent dir inside the live one is refused", () => {
  const ran = run([...unit, "-E", `PRIME_AGENT_CODING_AGENT_DIR=${live}/x`, "prime-agent", "--mode", "daemon", "--daemon-socket", `${scratch}/d.sock`]);
  assert.equal(ran.code, 2);
});

test("a scratch daemon unit with its own agent dir starts, and gets no Prime or chat dir from the kernel", () => {
  const quoted = `'env' '-i' 'PRIME_AGENT_CODING_AGENT_DIR=${scratch}/agent' 'prime-agent' '--mode' 'daemon' '--daemon-socket' '${scratch}/tmp/d.sock'`;
  const ran = run([...unit, "sh", "-c", quoted]);
  assert.equal(ran.code, 0, ran.err);
  assert.ok(ran.args.includes("RLM_SESSION_DIR"));
  for (const name of ["PRIME_AGENT_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "AGENT_CHAT_DATA_DIR"]) assert.ok(!ran.args.includes(name), name);
  assert.equal(ran.args.at(-1), quoted);
});

test("a unit on the public socket or with no prime-agent keeps the kernel's dirs as before", () => {
  const publicSock = `/tmp/prime-agent-${process.getuid()}/daemon.sock`;
  for (const command of [["prime-agent", "--daemon-socket", publicSock, "list"], ["sh", "-c", "python3 scan.py"]]) {
    const ran = run([...unit, ...command]);
    assert.equal(ran.code, 0, ran.err);
    assert.ok(ran.args.includes("PRIME_AGENT_CODING_AGENT_DIR"), command.join(" "));
  }
});


// p661 (10-31): a unit a Mac job starts over ssh gets no RLM_SESSION_DIR, so the shim passes the LC_PRIME_SESSION tag ssh carried in.
test("a unit gets LC_PRIME_SESSION when the caller has it, with or without RLM_SESSION_DIR", () => {
  const ran = spawnSync("sh", [wrapper, ...unit, "sleep", "1"], { encoding: "utf8",
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_PRIME_SESSION: "01a183f7-0a0b-725c-984d-d59f150e6420@Sieuns-MacBook-Pro" } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.stdout.trim().split("\n").slice(0, 2), ["-E", "LC_PRIME_SESSION"]);
  assert.ok(!run([...unit, "sleep", "1"]).args.includes("LC_PRIME_SESSION"));
});
