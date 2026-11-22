/**
 * pi-host runs pi-pool's token hook from the spawn host's small process (legacy/prime/user-history/src/spawn-host.ts), never by a fork of its
 * own. On 11-22 on us-metal02 pi-host forked about one hook a second from its 1 GB process, and each fork held its main thread 50 to 290 ms
 * (on CPU, then blocked until the child's exec), 49 of the 70 reads over 50 ms in 300 s (~/work/thread-reads/loop/sched-5.json).
 * The stand-in hook writes its parent's pid, which is pi-host's own pid only when pi-host forked it.
 */
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { poolProvider, TurnQueue } from "@sieun-pi/pi-pool/durable";
import { hostExecFile, stopSpawnHost } from "../../../../legacy/prime/user-history/src/spawn-host.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-pool-spawn-"));
after(() => {
  stopSpawnHost();
  rmSync(dir, { recursive: true, force: true });
});
const parents = join(dir, "parents");
const hook = join(dir, "pool-hook");
writeFileSync(hook, `#!/bin/sh
echo "$PPID $1 $2" >> '${parents}'
if [ "$1" = "--cli" ]; then echo '{"state": "admitted"}'; exit 0; fi
printf 'sk-ant-oat01-faux'
`);
chmodSync(hook, 0o755);
const calls = () => readFileSync(parents, "utf8").trim().split("\n").map(line => {
  const [ppid, ...args] = line.split(" ");
  return { ppid: Number(ppid), args: args.join(" ") };
});

test("the turn queue's pool calls and a request's token vend run from the spawn host, not from a fork of pi-host", async () => {
  const turns = new TurnQueue({ bin: hook, exec: hostExecFile });
  assert.equal(await turns.lead("add", "comm-session"), true, "the lead call reads the hook's exit 0");

  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-5-5" }], tokensPerSecond: 0 });
  faux.setResponses([fauxAssistantMessage("answered")]);
  const provider = poolProvider({ treeKey: "pi-durable:pool-spawn", bin: hook, inner: faux.provider, exec: hostExecFile });
  const model = provider.getModels().find(m => m.id === "claude-opus-5-5")!;
  const answer = await provider.stream(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never, {}).result();
  assert.equal(answer.stopReason, "stop", JSON.stringify(answer));

  const seen = calls();
  assert.deepEqual(seen.map(c => c.args), ["--cli lead", "--provider anthropic"]);
  for (const call of seen) assert.notEqual(call.ppid, process.pid, `${call.args} ran as a child of pi-host's own process`);
});
