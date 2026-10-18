// Guards the d1 kernel hold of 10-18: the live Chat reopen duty started its check with `nohup ... &` from bash(), and that handle ran until the check ended.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const DUTY = join(import.meta.dirname, "..", "scripts", "duties", "chat-reopen.duty.json");

test("the Chat reopen start line runs each check in its own systemd unit with its own output file, and never through nohup", async () => {
  const onMiss = (JSON.parse(readFileSync(DUTY, "utf8")) as { onMiss: string }).onMiss;
  const command = /await bash\('(.+?)'\)/.exec(onMiss)?.[1];
  assert.ok(command, "onMiss names the start line");
  assert.doesNotMatch(command, /\bnohup\b/);
  const home = mkdtempSync(join(tmpdir(), "chat-reopen-start-"));
  mkdirSync(join(home, ".local/share/sieun-pi-chat/current/components/user-history"), { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "$HOME/started-$$"\n`);
  chmodSync(join(bin, "systemd-run"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home };
  const starts: string[] = [];
  for (let index = 0; index < 2; index++) {
    const { stdout } = await promisify(execFile)("sh", ["-c", command], { env });
    starts.push(stdout.trim());
  }
  const runs = readdirSync(home).filter(name => name.startsWith("started-")).map(name => readFileSync(join(home, name), "utf8").trimEnd().split("\n"));
  assert.equal(runs.length, 2);
  const dir = join(home, ".prime/agent/clean-room/chat-reopen");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const seen = runs.map(([cwd, ...args]) => {
    assert.equal(cwd, join(home, ".local/share/sieun-pi-chat/current/components/user-history"));
    assert.deepEqual(args.slice(1, 7).filter(arg => !arg.startsWith("--unit=")), ["--collect", "--same-dir", "-E", "PATH", "sh"]);
    assert.equal(args[0], "--user");
    const unit = args.find(arg => arg.startsWith("--unit="))!.slice(7);
    const payload = args.at(-1)!;
    const out = new RegExp(`^node --import tsx scripts/clean-room/clean-room.ts reopen-check --dir ${dir} --cwd ${home}/src/sieun-pi > (${dir}/driver-\\S+\\.out) 2>&1$`).exec(payload)?.[1];
    assert.ok(out, payload);
    assert.equal(unit, `chat-reopen-check-${out.slice(dir.length + "/driver-".length, -".out".length)}`);
    assert.ok(starts.includes(`unit ${unit}, output ${out}`), starts.join(" | "));
    return { unit, out };
  });
  assert.notEqual(seen[0]!.unit, seen[1]!.unit);
  assert.notEqual(seen[0]!.out, seen[1]!.out);
});
