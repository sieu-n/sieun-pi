// A Prime root's agent_message.send to a pi-host thread (vent, 230bbdbf) lands in that thread as an agent.message input, through
// src/pi-thread-message.ts and message-limit-check.py point 10, and the root's agent_observe.list_agents lists pi-host's threads.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { messageCheckPrelude } from "../src/message-limit-check.ts";
import { pickThread, type Route, sendAlert, sendToThread, threadText } from "../src/pi-thread-message.ts";

const VENT = "230bbdbf-4d84-475f-95d2-63db2f90ca34";
const FACTORY = "72ba1ed2-e04e-4284-a4da-3547edb6a3d9";
const ROOT = "01a11d24-ac9b-757d-ac51-9b2b7598782f";
const MAC_ROOT = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const THREADS = [
  { id: VENT, name: "vent", status: "idle" },
  { id: FACTORY, name: "agent factory", status: "running" },
  { id: "5a1c0d2e-0000-4000-8000-000000000001", name: "twin", status: "idle" },
  { id: "5a1c0d2e-0000-4000-8000-000000000002", name: "twin", status: "idle" },
  { id: "5a1c0d2e-0000-4000-8000-000000000003", name: "release driver", status: "idle" },
];

/** pi-host as the helper sees it: the hello, durable_threads, and durable_submit, each submit kept in `submits`. */
async function fakeHost(dir: string): Promise<{ socket: string; server: Server; submits: Record<string, unknown>[] }> {
  const socket = join(dir, "host.sock");
  const submits: Record<string, unknown>[] = [];
  const server = createServer(client => {
    client.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } })}\n`);
    let buffer = "";
    client.on("data", chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const command = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        const answer = (data: unknown) => client.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })}\n`);
        if (command.type === "durable_threads") answer({ threads: THREADS });
        else if (command.type === "durable_submit") {
          submits.push(command);
          answer({ submission: `sub-${submits.length}`, requestId: command.requestId, status: "placed" });
        }
      }
    });
  });
  server.listen(socket);
  await once(server, "listening");
  return { socket, server, submits };
}

test("a send to a thread's full id is one durable_submit with the agent.message entry, the sender's id, a keyed request id and the header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-thread-message-"));
  const host = await fakeHost(dir);
  try {
    const route: Route = { box: "us-metal02", socket: host.socket };
    const receipt = await sendToThread([route], { from: { id: ROOT, name: "metal box owner" }, to: VENT, message: "is the relay up?", id: "m1" });
    assert.equal(host.submits.length, 1);
    const submit = host.submits[0]!;
    assert.deepEqual([submit.thread, submit.requestId, submit.whenBusy], [VENT, "agentmsg:m1", "steer"]);
    assert.deepEqual(submit.entry, { kind: "agent.message", data: { from: ROOT, via: "agent_message" } });
    const [first, blank, ...rest] = String(submit.text).split("\n");
    assert.match(first!, new RegExp(`^\\[agent-message from sibling:metal box owner \\(${ROOT}, a Prime session on [\\w.-]+\\); answer with ` +
      `agent_message\\.send\\(text, receiver_role="sibling", receiver_name="${ROOT}"\\)\\]$`));
    assert.deepEqual([blank, rest.join("\n")], ["", "is the relay up?"]);
    assert.deepEqual([receipt.deliveryStatus, (receipt.target as { sessionId: string }).sessionId, receipt.host, receipt.requestId], ["delivered", VENT, "us-metal02", "agentmsg:m1"]);

    await sendToThread([route], { from: { id: ROOT, name: "metal box owner" }, to: "vent", message: "again", id: "m2" });
    assert.equal(host.submits[1]!.thread, VENT, "an exact name names its thread");
  } finally {
    host.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a send from a pi-host thread or one of its jobs names the thread and points the reply at the thread's root, never a Prime session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-thread-message-"));
  const host = await fakeHost(dir);
  try {
    const route: Route = { box: "us-metal02", socket: host.socket };
    const job = `${FACTORY}:10605`;
    await sendToThread([route], { from: { id: job, name: "agent factory's job \"vent alerts to pi thread\"" }, to: VENT, message: "the bridge is live", id: "vent-alerts-live-1" });
    const fromJob = host.submits[0]!;
    assert.deepEqual(fromJob.entry, { kind: "agent.message", data: { from: job, via: "agent_message" } });
    const first = String(fromJob.text).split("\n")[0]!;
    assert.equal(first, `[agent-message from sibling:agent factory's job "vent alerts to pi thread" (${job}, a job in the pi-host thread agent factory ${FACTORY} on us-metal02); ` +
      `a job of another thread takes no message, so answer its thread with agent_message.send(text, receiver_role="sibling", receiver_name="${FACTORY}")]`);
    assert.doesNotMatch(first, /Prime session/);

    await sendToThread([route], { from: { id: FACTORY, name: "agent factory" }, to: VENT, message: "p145 was a test send", id: "m3" });
    assert.equal(String(host.submits[1]!.text).split("\n")[0], `[agent-message from sibling:agent factory (${FACTORY}, a pi-host thread on us-metal02); ` +
      `answer with agent_message.send(text, receiver_role="sibling", receiver_name="${FACTORY}")]`);
  } finally {
    host.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the alert bridge's send to a thread is one durable_submit from alert-bridge with its request id and the header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-thread-message-"));
  const host = await fakeHost(dir);
  try {
    await sendAlert([{ box: "us-metal02", socket: host.socket }], VENT, "[alert] A Grafana rule this thread owns fired.", "alert:vent-health-failure-rate-prod@1");
    assert.equal(host.submits.length, 1);
    const submit = host.submits[0]!;
    assert.deepEqual([submit.thread, submit.requestId, submit.whenBusy, submit.entry], [VENT, "alert:vent-health-failure-rate-prod@1", "steer",
      { kind: "agent.message", data: { from: "alert-bridge", via: "alert-bridge" } }]);
    assert.equal(submit.text, "[agent-message from alert bridge]\n\n[alert] A Grafana rule this thread owns fired.");
    await assert.rejects(sendAlert([{ box: "us-metal02", socket: host.socket }], "5a1c0d2e", "x", "alert:x@1"), /No live pi-host thread has the id 5a1c0d2e/);
  } finally {
    host.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a thread is named by its full id or exact name only: a prefix names none, and a shared name names both", () => {
  const rows = THREADS.map(thread => ({ thread: { ...thread, box: "us-metal02" } }));
  assert.equal((pickThread(rows, VENT) as { thread: { id: string } }).thread.id, VENT);
  assert.equal((pickThread(rows, " vent ") as { thread: { id: string } }).thread.id, VENT);
  assert.match((pickThread(rows, "230bbdbf") as { error: string }).error, /No pi-host thread has the id or the name "230bbdbf"/);
  assert.match((pickThread(rows, "Vent") as { error: string }).error, /No pi-host thread/);
  const twin = pickThread(rows, "twin") as { error: string };
  assert.match(twin.error, /"twin" names 2 pi-host threads/);
  assert.ok(twin.error.includes("5a1c0d2e-0000-4000-8000-000000000001") && twin.error.includes("5a1c0d2e-0000-4000-8000-000000000002"));
  assert.equal(threadText({ id: ROOT, name: "a]b" }, "mac", "x").split("\n")[0]!.startsWith("[agent-message from sibling:a b ("), true);
});

test("a Prime root's kernel lists pi-host threads as siblings, sends to one by id or name, and refuses a name a Prime root also has", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-thread-wrapper-"));
  const host = await fakeHost(dir);
  // The chat service lists one root on the Mac, "release driver", which a pi-host thread is named too.
  const chat = createHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url!.includes("api/agent/siblings")
      ? { agents: [{ sessionId: MAC_ROOT, sessionName: "release driver", runtimeKind: "top-level", relationship: "sibling", host: "mac", crossHost: true }] }
      : { error: "unexpected" }));
  });
  chat.listen(0, "127.0.0.1");
  await once(chat, "listening");
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${(chat.address() as { port: number }).port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  // The local daemon has one sibling, "ops guy", and no pi-host thread.
  await writeFile(join(dir, "rlm.py"), [
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_message.send':",
    "        raise RuntimeError('No sibling matches ' + payload['receiver_name'])",
    `    return {'current': {'sessionId': '${ROOT}', 'sessionName': 'metal box owner'},`,
    "            'agents': [{'sessionId': '01a0e0ca-ee06-776f-b18d-cbdffca4c85c', 'sessionName': 'ops guy', 'relationship': 'sibling'}]}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, agent_message",
    "async def send(to):",
    "    try:",
    "        return await agent_message.host_request('agent_message.send', {'message': 'ping', 'receiver_role': 'sibling', 'receiver_name': to})",
    "    except Exception as error:",
    "        return {'error': str(error)}",
    "async def main():",
    "    roster = await agent_message.host_request('agent_observe.list', {})",
    `    out = {'listed': [a['sessionName'] for a in roster['agents'] if a.get('piThread')], 'byId': await send('${VENT}'), 'byName': await send('vent'),`,
    "           'prefix': await send('230bbdbf'), 'both': await send('release driver')}",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  try {
    const sessionDir = join(dir, "session-artifacts", ROOT);
    await mkdir(sessionDir, { recursive: true });
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONPATH: dir,
      RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json"), PI_HOST_SOCKET: host.socket, PI_AGENT_BUS_BOXES: join(dir, "no-boxes.json") } });
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(out.listed, THREADS.map(thread => thread.name));
    assert.deepEqual([out.byId.deliveryStatus, out.byId.target.sessionId, out.byId.piThread], ["delivered", VENT, true]);
    assert.equal(out.byName.target.sessionId, VENT);
    assert.deepEqual(host.submits.map(submit => [submit.thread, (submit.entry as { data: { from: string } }).data.from]), [[VENT, ROOT], [VENT, ROOT]]);
    assert.notEqual(host.submits[0]!.requestId, host.submits[1]!.requestId);
    assert.ok(String(host.submits[0]!.text).startsWith("[agent-message from sibling:metal box owner ("));
    assert.match(out.prefix.error, /No sibling matches 230bbdbf/, "an id prefix of a thread goes to no thread");
    assert.match(out.both.error, /"release driver" names the pi-host thread release driver \(5a1c0d2e-0000-4000-8000-000000000003\), the Prime root release driver \(01a10810-34b5-710f-88fe-3d369f89a8c9\)/);
    assert.equal(host.submits.length, 2);
  } finally {
    host.server.close();
    chat.close();
    await rm(dir, { recursive: true, force: true });
  }
});
