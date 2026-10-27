// Owner 10-12 (frontend bro's d6): "make sure i'll not give the same feedback". These cases pin that d6 reads a sleeping Mac as away, not error.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MAC_HOST, macCommand } from "../scripts/duties/mac-reach.ts";
import { hostAwayOf, type PrecheckOutput } from "../src/shared/chat-duties.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("d6's precheck runs the box script, which keeps the Mac command the duty ran before", async () => {
  const duty = JSON.parse(await readFile(join(root, "scripts/duties/staging-design-rules.duty.json"), "utf8")) as { precheck: { command: string[]; cwd: string } };
  assert.deepEqual(duty.precheck.command, ["node", "--import", "tsx", "scripts/duties/staging-design-rules-box.ts"]);
  assert.equal(duty.precheck.cwd, "../..");
  assert.equal(macCommand("scripts/duties/staging-design-rules.ts"), "export PATH=/Users/sieunpark/.hermes/node/bin:$PATH; " +
    "cd ~/Documents/Github/sieun-pi/legacy/prime/user-history || exit 2; f=$(mktemp); OUTPUT_FILE=$f node --import tsx " +
    "scripts/duties/staging-design-rules.ts; s=$?; cat $f; rm -f $f; exit $s");
});

test("a Mac Tailscale lists offline makes d6's box script write a host_away output and exit 0 without ssh to it", async () => {
  const bin = await mkdtemp(join(tmpdir(), "d6-box-"));
  try {
    const dialed = join(bin, "dialed");
    await writeFile(join(bin, "ssh"), `#!/bin/sh\nif [ "$1" = -G ]; then echo "hostname 100.66.173.18"; exit 0; fi\ntouch ${dialed}; exit 255\n`);
    const status = { Peer: { mac: { TailscaleIPs: ["100.66.173.18"], Online: false, LastSeen: "2026-10-26T21:30:00Z" } } };
    await writeFile(join(bin, "tailscale"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`);
    await chmod(join(bin, "ssh"), 0o755);
    await chmod(join(bin, "tailscale"), 0o755);
    const output = join(bin, "out.json");
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/staging-design-rules-box.ts"],
      { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUTPUT_FILE: output } });
    const read = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.deepEqual(read.metrics, {});
    assert.equal(hostAwayOf(read), MAC_HOST);
    assert.match(read.flagged![0]!.excerpt!, /repeated_design_notes_24h and design_rule_test_failures are not measured/);
    await assert.rejects(readFile(dialed));
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
