// Guards owner rule c98 for agent messages: on 10-18 Prime's daemon refused ops guy's send to Vent and several of the AI harness chat's sends to
// VP of CI with "Target session has too many pending messages: 21 unfinished, limit is 20", and each sender had to remember a retry. Such a
// send now waits in the chat service's agent outbox and the sender gets a "queued" receipt (message-limit-check.py `queued`).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { AgentOutbox, type QueuedSend } from "../src/agent-outbox.ts";
import { faultReason, readQueueOverruns } from "../src/daemon-faults.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";
import { measure } from "../scripts/duties/whole-system.ts";

const SENDER = "01a11d24-ac9b-757d-ac51-9b2b7598782f";
const VENT = "01a10db8-b6d5-7219-ac49-2efa75ad73d8";
const REFUSAL = "Target session has too many pending messages: 21 unfinished, limit is 20";

const until = async (done: () => boolean | Promise<boolean>) => { for (let i = 0; i < 2_000 && !await done(); i++) await new Promise(resolve => setTimeout(resolve, 10)); };

test("a send to a session with 21 pending returns queued, lands once when the queue drains, and a later send keeps its order", async t => {
  const dir = await mkdtemp(join(tmpdir(), "queue-full-"));
  const full = join(dir, "full");
  await writeFile(full, "");
  const daemon = { unfinished: 21, delivered: [] as string[], refused: 0 };
  const lines: string[] = [];
  const messages = new AgentOutbox(join(dir, "agent-outbox"), { log: line => { lines.push(line); }, sleep: () => new Promise(resolve => setTimeout(resolve, 10)),
    send: async (_session, text) => {
      if (daemon.unfinished >= 20) { daemon.refused++; throw new Error(REFUSAL); }
      daemon.delivered.push(text);
      return "sent";
    },
    target: async () => ({ queued: [], busy: true, unfinished: daemon.unfinished }),
    fileOf: async () => null });
  t.after(() => messages.close());
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      // The sender is a root, so the wrapper first reads the other boxes' roots; there are none.
      if (req.url!.includes("api/agent/siblings")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ agents: [] })); return; }
      const sent = JSON.parse(body) as Record<string, unknown>;
      const send: QueuedSend = { session: sent.to as string, text: sent.message as string, from: sent.from as QueuedSend["from"], role: sent.role as QueuedSend["role"],
        behind: sent.behind === true, ...typeof sent.pending === "number" ? { pending: sent.pending } : {}, ...typeof sent.limit === "number" ? { limit: sent.limit } : {},
        ...typeof sent.root === "string" ? { root: sent.root } : {} };
      assert.ok(req.url!.endsWith("api/agent/queue"));
      messages.queue(send).then(value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); });
  const port = (server.address() as { port: number }).port;
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  // The sender's daemon refuses every send while the file `full` exists, as Prime's does while the target holds 20 or more unfinished messages.
  await writeFile(join(dir, "rlm.py"), [
    "import os",
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_message.send':",
    `        if os.path.exists(${JSON.stringify(full)}):`,
    `            raise RuntimeError(${JSON.stringify(REFUSAL)})`,
    "        open('direct-sends.txt', 'a').write(payload['message'] + '\\n')",
    "        return {'deliveryStatus': 'delivered'}",
    `    return {'current': {'sessionId': '${SENDER}', 'sessionName': 'ops guy'},`,
    `            'agents': [{'sessionId': '${VENT}', 'sessionName': 'Vent', 'relationship': 'sibling', 'runtimeKind': 'top-level'}]}`,
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const go = join(dir, "go");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, os, agent_message",
    "async def send(text):",
    "    return await agent_message.host_request('agent_message.send', {'message': text, 'receiver_role': 'sibling', 'receiver_name': 'Vent'})",
    "async def main():",
    "    out = [await send('first'), await send('second')]",
    `    open(${JSON.stringify(join(dir, "queued"))}, 'w').write('')`,
    `    while not os.path.exists(${JSON.stringify(go)}):`,
    "        await asyncio.sleep(0.05)",
    "    out.append(await send('third'))",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  const sessionDir = join(dir, "session-artifacts", SENDER);
  await mkdir(sessionDir, { recursive: true });
  const run = promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json"),
        PI_HOST_SOCKET: join(dir, "no-pi-host.sock"), PI_AGENT_BUS_BOXES: join(dir, "no-boxes.json") } });
  await until(() => access(join(dir, "queued")).then(() => true, () => false));
  assert.deepEqual(daemon.delivered, [], "nothing reaches the target while it is full");
  assert.equal(daemon.refused, 0, "the outbox reads the target's room before it sends, so the daemon refuses nothing more");
  daemon.unfinished = 3;
  await rm(full);
  await messages.outbox.idle();
  await writeFile(go, "");
  const { stdout } = await run;
  const [first, second, third] = JSON.parse(stdout.trim().split("\n").at(-1)!);
  assert.equal(first.deliveryStatus, "queued");
  assert.equal(first.note, "queued: Vent has 21 pending (target 20), delivers when it drains");
  assert.equal(second.deliveryStatus, "queued", "a send behind a queued one waits behind it, so the two keep their order");
  assert.equal(third.deliveryStatus, "delivered", "once the outbox drained, sends go to the daemon again");
  assert.equal(daemon.delivered.length, 1, "the two queued sends land once, together in one send");
  assert.match(daemon.delivered[0]!, /^\[2 messages .*\n\n\[1 of 2, [^\]]*\]\n\n\[message from sibling ops guy \(01a11d24-ac9b-757d-ac51-9b2b7598782f\), held in the chat service's outbox .*receiver_role="sibling", receiver_name="01a11d24-ac9b-757d-ac51-9b2b7598782f"\)\]\n\nfirst\n\n\[2 of 2, /);
  assert.match(daemon.delivered[0]!, /\n\nsecond$/);
  assert.equal(lines.filter(line => /queued m-\S+ from ops guy \(01a11d24\) while the target held 21 of 20 pending, 0 ahead/.test(line)).length, 1);
  assert.equal(lines.filter(line => /try \d+/.test(line)).length, 0);
});

test("the Whole system precheck shows over-target queues as a detail line and no dirty minute", () => {
  const now = Date.parse("2026-10-18T17:00:30Z");
  const log = [
    "2026-10-18T16:40:05.000Z outbox 01a10db8: queued m-1 from ops guy (01a11d24) while the target held 21 of 20 pending, 0 ahead of it here",
    "2026-10-18T16:41:05.000Z outbox 01a10db8: queued m-2 from ops guy (01a11d24) while the target held 23 of 20 pending, 1 ahead of it here",
    "2026-10-18T16:42:05.000Z outbox 01a0cc5e on mac: the target is full at 20 of 20 pending; m-3 and the sends after it wait until it holds fewer",
    "2026-10-18T16:42:06.000Z outbox 01a0cc5e on mac: m-3 try 1: Target session has too many pending messages: 20 unfinished, limit is 20",
  ];
  const overruns = readQueueOverruns(log, "us-metal02");
  assert.deepEqual(overruns.map(entry => [entry.session, entry.host, entry.pending, entry.limit]), [["01a10db8", "us-metal02", 21, 20], ["01a10db8", "us-metal02", 23, 20], ["01a0cc5e", "mac", 20, 20]]);
  assert.equal(faultReason(REFUSAL), undefined, "a refusal the outbox waits out is no daemon fault");
  const { flagged, metrics } = measure({ now, watch: [], log: { holds: [] }, chats: [{ id: VENT, name: "Vent", duties: [], runs: [] }], queueOverruns: overruns, daemonFaults: [] });
  assert.equal(metrics.daemon_fail_min_30, 0);
  assert.equal(flagged?.find(slice => slice.kind === "dirty_minutes"), undefined);
  assert.equal(flagged?.find(slice => slice.kind === "queue_overruns")?.excerpt,
    "2 targets held more pending messages than the daemon's target, and their sends waited in the agent outbox, not counted dirty: " +
    "Vent on us-metal02 at up to 23 of 20 (2 sends from 16:40Z); session 01a0cc5e on mac at up to 20 of 20 (1 send from 16:42Z)");
});
