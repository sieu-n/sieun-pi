// Owner 10-19 (goal p1 of frontend bro): the 5180 demo works offline; these cases pin how the box side of its duty treats a sleeping Mac.
import assert from "node:assert/strict";
import { test } from "node:test";
import { boxPrecheck, MAC_HOST } from "../scripts/duties/mac-reach.ts";
import { HOST_AWAY, hostAwayOf, type PrecheckOutput } from "../src/shared/chat-duties.ts";

test("a Mac Tailscale lists offline gives a host_away output and no ssh", async () => {
  let dialed = false;
  const result = await boxPrecheck({
    away: async () => ({ at: 1, kind: HOST_AWAY, host: MAC_HOST, excerpt: "the Mac is offline on the tailnet" }),
    silent: async () => { throw new Error("no ssh, so no ping"); },
    ssh: async () => { dialed = true; return { code: 255, stdout: "", stderr: "ssh: connect to host 100.66.173.18 port 22: Connection timed out" }; },
  });
  assert.equal(dialed, false);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.text) as PrecheckOutput;
  assert.deepEqual(output.metrics, {});
  assert.equal(hostAwayOf(output), MAC_HOST);
});

test("an online Mac passes its output, stderr and exit code through", async () => {
  const result = await boxPrecheck({ away: async () => undefined, silent: async () => { throw new Error("ssh worked"); },
    ssh: async () => ({ code: 0, stdout: '{"metrics":{"walk_problems":0}}', stderr: "note" }) });
  assert.deepEqual(result, { code: 0, text: '{"metrics":{"walk_problems":0}}', stderr: "note" });
  const failed = await boxPrecheck({ away: async () => undefined, silent: async () => undefined, ssh: async () => ({ code: 255, stdout: "", stderr: "timed out" }) });
  assert.equal(failed.code, 255);
});

test("an ssh that times out on a Mac that answers no tailscale ping gives a host_away output", async () => {
  const result = await boxPrecheck({
    away: async () => undefined,
    silent: async () => ({ at: 1, kind: HOST_AWAY, host: MAC_HOST, excerpt: "the Mac answered no ssh and no tailscale ping" }),
    ssh: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host 100.66.173.18 port 22: Connection timed out" }),
  });
  assert.equal(result.code, 0);
  assert.equal(hostAwayOf(JSON.parse(result.text) as PrecheckOutput), MAC_HOST);
  assert.match(result.stderr, /Connection timed out/);
});
