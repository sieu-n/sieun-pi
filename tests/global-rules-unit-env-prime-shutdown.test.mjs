import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// On 10-27 at 16:55:06Z and 17:07:46Z a service-handoff proof ran `HOME=<scratch>/r01/h TMPDIR=/tmp/svh-r01 prime-agent shutdown --force --json`
// for its scratch daemon, the CLI used the public socket, and the live daemon on us-metal02 stopped both times with every agent on it.
const env = join(dirname(fileURLToPath(import.meta.url)), "../components/global-rules/unit-env");
const root = realpathSync(mkdtempSync(join(tmpdir(), "unit-env-shutdown-")));
test.after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "real-bin");
mkdirSync(bin);
writeFileSync(join(bin, "prime-agent"), "#!/bin/sh\nprintf 'ran %s\\n' \"$*\"\n", { mode: 0o755 });

const run = (args, extra = {}) => {
  const ran = spawnSync("prime-agent", args, { encoding: "utf8", env: { HOME: root, PATH: `${env}:${bin}:/usr/bin:/bin`, ...extra } });
  return { code: ran.status, out: ran.stdout.trim(), err: ran.stderr };
};
const publicSock = `/tmp/prime-agent-${process.getuid()}/daemon.sock`;

test("prime-agent shutdown with no socket or the public socket is refused before the real CLI runs", () => {
  for (const [args, extra] of [[["shutdown", "--force", "--json"], { TMPDIR: "/tmp/svh-r01", HOME: `${root}/r01/h` }],
    [["--daemon-socket", publicSock, "shutdown", "--force"], {}], [[`--daemon-socket=${publicSock}`, "shutdown"], {}]]) {
    const ran = run(args, extra);
    assert.equal(ran.code, 2, args.join(" "));
    assert.equal(ran.out, "");
    assert.match(ran.err, /refused: 'prime-agent shutdown' would stop the live daemon/);
  }
});

test("a shutdown that names a scratch socket, stop of one agent and every other command run the real CLI", () => {
  for (const args of [["--daemon-socket", `${root}/svh/daemon.sock`, "shutdown", "--force"], ["stop", "abc123"], ["list", "--json"], ["send", "x", "shutdown"]]) {
    const ran = run(args);
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.out, `ran ${args.join(" ")}`);
  }
});
