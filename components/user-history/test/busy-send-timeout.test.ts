import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

// p334, 10-12 17:08Z: a check-in's agent_message.send to the running chats Crawler VP and frontend bro raised this after 33.8 s and 38.0 s.
// Both messages still landed, at 17:16:20Z and 17:10:13Z, when each chat's running ipython call (758 s and 459 s) ended. Senders read the error
// as a failure and sent again, so frontend bro got one ask 7 times between 15:42Z and 17:10Z.
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message". Socket: ' +
  "/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/prime-agent-501/daemon.sock. Daemon log: /Users/sieunpark/.prime/agent/logs/daemon.sock.bab13329.log.";

const kernel = async (oldWrapper: boolean) => {
  const dir = await mkdtemp(join(tmpdir(), "busy-send-"));
  await writeFile(join(dir, "rlm.py"), [
    "sent = []",
    "async def host_request(request_type, payload=None):",
    "    sent.append(request_type)",
    "    text = (payload or {}).get('message', '')",
    "    if text.startswith('timeout'): raise RuntimeError(" + JSON.stringify(TIMEOUT) + ")",
    "    if text.startswith('unknown'): raise RuntimeError('Unknown active session: frontend bro')",
    "    if request_type != 'agent_message.send': raise RuntimeError(" + JSON.stringify(TIMEOUT.replace("send_message", "list")) + ")",
    "    return {'deliveryStatus': 'delivered'}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\nasync def send(message, *, receiver_role=None, receiver_name=None):\n" +
    "    return await host_request('agent_message.send', {'message': message, 'receiver_role': receiver_role, 'receiver_name': receiver_name})\n");
  // A kernel that ran the first version of the check holds its wrapper and the flag True; the new prelude must replace that wrapper.
  const old = oldWrapper ? [
    "import sys, rlm, agent_message",
    "async def old(request_type, payload=None, *a, **k):",
    "    return await rlm.unchecked_host_request(request_type, payload, *a, **k)",
    "old.limit_checked = True",
    "rlm.unchecked_host_request = rlm.host_request",
    "rlm.host_request = agent_message.host_request = old",
    "sys.user_history_message_check = True",
  ].join("\n") + "\n" : "";
  const script = old + messageCheckPrelude(dir) + [
    "import asyncio, json, agent_message, rlm",
    "async def main():",
    "    out = []",
    "    for text in ['timeout: please check p42', 'unknown: hi', 'fine: hi']:",
    "        try:",
    "            receipt = await agent_message.send(text, receiver_role='sibling', receiver_name='frontend bro')",
    "            out.append(receipt.get('deliveryStatus'))",
    "        except Exception as error:",
    "            out.append('raised: ' + str(error)[:40])",
    "    try:",
    "        await rlm.host_request('agent_observe.list_agents', {})",
    "        out.append('list ok')",
    "    except Exception as error:",
    "        out.append('list raised')",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  return spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, encoding: "utf8" });
};

for (const oldWrapper of [false, true]) {
  test(`p334: a send the daemon times out on returns an unconfirmed receipt with a do-not-resend note${oldWrapper ? ", also in a kernel that holds the old wrapper" : ""}`, async () => {
    const run = await kernel(oldWrapper);
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.deepEqual(JSON.parse(lines.at(-1)!), ["unconfirmed", "raised: Unknown active session: frontend bro", "delivered", "list raised"]);
    assert.match(run.stdout, /Do not send it again/);
  });
}
