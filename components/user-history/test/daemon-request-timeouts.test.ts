import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

/** prime-agent's own bound for one daemon request: DEFAULT_DAEMON_REQUEST_TIMEOUT_MS in dist/modes/daemon/daemon-client.js. */
async function primeAgentDefault(): Promise<number> {
  const client = new URL("../node_modules/prime-agent/dist/modes/daemon/daemon-client.js", import.meta.url);
  const match = /const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(await readFile(client, "utf8"));
  assert.ok(match, "prime-agent still names its default daemon request timeout");
  return Number(match[1]!.replaceAll("_", ""));
}

const SRC = new URL("../src/", import.meta.url);

test("daemon requests: no request in src gives up sooner than prime-agent's own 30 s default (service.log 10-12 16:05Z: 411 cron_list and 430 get_state timeouts at an unmeasured 10 s, c43)", async () => {
  const limit = await primeAgentDefault();
  assert.equal(limit, 30_000);
  const shorter: string[] = [];
  for (const name of await readdir(SRC, { recursive: true })) {
    if (!/\.(ts|mjs)$/.test(name)) continue;
    const text = await readFile(new URL(name, SRC), "utf8");
    for (const call of text.matchAll(/\.request\(\{ type: "(\w+)"[^\n]*?\}, ([\d_]+), \{/g)) {
      if (Number(call[2]!.replaceAll("_", "")) < limit) shorter.push(`${name}: ${call[1]} at ${call[2]} ms`);
    }
  }
  assert.deepEqual(shorter, [], "pass undefined to use prime-agent's default, or cite the measurement that backs a shorter bound");
});
