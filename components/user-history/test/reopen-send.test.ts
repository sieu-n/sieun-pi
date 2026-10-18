// From 10-18: the roots "runner reviewer" (01a11d25) and "verify-dev speed" (01a14b7a) sat failed on the Mac, every send to them answered
// "Session worker is failed" until a job opened each from its file with a daemon create (05:37Z, 05:45Z), and each workflow change waited on
// them; and us-metal02 answered "Unknown active session" for 94 subagents of moved chats whose spawn-ledger edges stayed on the Mac.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { reopenSibling, type Root, type RootDirectory } from "../src/cross-host-message.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";
import { adoptMoved, type DaemonAnswer, type ReopenCatalog, reopenSession, sendReopening, treeRoot } from "../src/reopen-send.ts";

const REVIEWER = "01a11d25-4c00-7613-9039-7a8377db04bb";
const VP_OF_CI = "01a1180e-6567-747f-bf44-452520ebdd1b";
const JOB = "01a143e0-6f72-74ad-897c-055eb7c7a603";
const FAILED = "Session worker is failed";

/** One box's daemon: a session is failed until a create opens it; every request lands in `requests`. */
function daemon(file: string, name = "mac") {
  const requests: Record<string, unknown>[] = [];
  let failed = true;
  const client = {
    name,
    async request(command: Record<string, unknown>): Promise<DaemonAnswer> {
      requests.push(command);
      if (command.type === "create") {
        if (command.sessionPath !== file) return { success: false, error: `no session file ${String(command.sessionPath)}` };
        failed = false;
        return { success: true, data: { sessionId: REVIEWER, activeSessionId: "3fedc5d47878" } };
      }
      if (command.targetActiveSessionId === JOB) return { success: false, error: `Unknown active session: ${JOB}` };
      return failed ? { success: false, error: FAILED } : { success: true, data: { deliveryStatus: "delivered" } };
    },
  };
  return { requests, client };
}

type Box = ReturnType<typeof daemon>;

/** The chat service's catalog: the reviewer root and a subagent of a chat tree in `agentDir`; `host` runs the reviewer, `here` is this box. */
function catalog(file: string, owner: Box, { host = null as string | null, here = owner, agentDir = "/nowhere" } = {}): ReopenCatalog {
  const rows: Record<string, SessionSummary> = {
    [REVIEWER]: { sessionId: REVIEWER, sessionFile: file, runtimeKind: "top-level", rlmDepth: 0, workerState: "failed", activeSessionId: "6651855423a4" } as SessionSummary,
    [JOB]: { sessionId: JOB, sessionFile: join(agentDir, "session-artifacts", VP_OF_CI, "sub-881d2ae9", `${JOB}.jsonl`), runtimeKind: "subagent", rlmDepth: 1 } as SessionSummary,
  };
  return { summary: async id => rows[id], daemonPath: summary => summary.sessionFile, hostOf: id => id === REVIEWER ? host : null,
    daemonFor: async () => owner.client, hostClient: async () => here.client, refresh: async () => {} };
}

test("a send to a root whose worker failed opens it from its file and goes out once more", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reopen-send-"));
  const file = join(dir, `${REVIEWER}.jsonl`);
  await writeFile(file, "{}\n");
  const box = daemon(file);
  const lines: string[] = [];
  const send = (session: string) => () => box.client.request({ type: "send_message", targetActiveSessionId: session, message: "review d789534318" });
  const answer = await sendReopening(REVIEWER, send(REVIEWER), id => reopenSession(catalog(file, box), { agentDir: dir }, id), line => lines.push(line));
  assert.deepEqual(answer, { success: true, data: { deliveryStatus: "delivered" } });
  assert.deepEqual(box.requests.map(request => request.type), ["send_message", "create", "send_message"]);
  assert.deepEqual(box.requests[1], { type: "create", lifecycle: "resident", sessionPath: file });
  assert.match(lines[0]!, /^reopen: 01a11d25 answered "Session worker is failed"; opened it again and sent again: sent$/);
  // A later send to the open root needs no reopen.
  assert.deepEqual(await sendReopening(REVIEWER, send(REVIEWER), () => { throw new Error("no reopen"); }), { success: true, data: { deliveryStatus: "delivered" } });
});

test("a root with no file and a refused create are no reopen; a root moved here opens here, not on the box with the dead worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reopen-send-"));
  const file = join(dir, `${REVIEWER}.jsonl`);
  const mac = daemon(file);
  assert.equal(await reopenSession(catalog(file, mac), { agentDir: dir }, REVIEWER), false, "this box's root whose file is gone");
  assert.deepEqual(mac.requests, []);
  // Another box's file is that box's to check.
  assert.equal(await reopenSession(catalog(file, mac, { host: "mac" }), { agentDir: dir }, REVIEWER), true);
  await assert.rejects(reopenSession(catalog(file, daemon("/Users/x/other.jsonl"), { host: "mac" }), { agentDir: dir }, REVIEWER), /reopen of 01a11d25 from .*: no session file/);
  // The Mac lists the root with a failed worker, and this box holds the moved chat's file: it opens on this box from that file.
  const local = join(dir, "sessions", `${REVIEWER}.jsonl`);
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(local, "{}\n");
  const stale = daemon(file), box = daemon(local, "us-metal02");
  assert.equal(await reopenSession(catalog(file, stale, { host: "mac", here: box }), { agentDir: dir }, REVIEWER), true);
  assert.deepEqual([stale.requests, box.requests], [[], [{ type: "create", lifecycle: "resident", sessionPath: local }]]);
});

test("a moved chat's subagent gets its spawn-ledger edges and the send goes once more; one with every edge is left to the relay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reopen-send-"));
  const box = daemon(join(dir, "none.jsonl"));
  const adopted: string[] = [];
  let edges = 1;
  const reopen = (id: string) => reopenSession(catalog("", box, { agentDir: dir }), { agentDir: dir, adopt: async root => { adopted.push(root); return edges; } }, id);
  let held = true;
  const send = async (): Promise<DaemonAnswer> => held ? (held = false, { success: false, error: `Unknown active session: ${JOB}` }) : { success: true, data: { deliveryStatus: "delivered" } };
  assert.deepEqual(await sendReopening(JOB, send, reopen), { success: true, data: { deliveryStatus: "delivered" } });
  assert.deepEqual(adopted, [VP_OF_CI]);
  edges = 0;
  held = true;
  assert.deepEqual(await sendReopening(JOB, send, reopen), { success: false, error: `Unknown active session: ${JOB}` });
  assert.deepEqual(box.requests, [], "a subagent never gets a create of its own");
});

test("adoptMoved runs prime-relay's adopt-moved-subagents.py on the tree, and a second run appends nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reopen-adopt-"));
  const sub = join(dir, "session-artifacts", VP_OF_CI, "sub-881d2ae9");
  await mkdir(sub, { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "rlm-ledger"), { recursive: true });
  await writeFile(join(dir, "sessions", `${VP_OF_CI}.jsonl`), "{}\n");
  await writeFile(join(sub, `${JOB}.jsonl`), "{}\n");
  await writeFile(join(sub, "rlm-subagent.json"), JSON.stringify({ childId: "sub-881d2ae9", sessionName: "verify-dev speed", sessionFile: join(sub, `${JOB}.jsonl`) }));
  assert.equal(treeRoot(dir, join(sub, `${JOB}.jsonl`)), VP_OF_CI);
  assert.equal(treeRoot(dir, join(dir, "sessions", `${VP_OF_CI}.jsonl`)), null);
  assert.equal(await adoptMoved(VP_OF_CI, dir), 1);
  assert.equal(await adoptMoved(VP_OF_CI, dir), 0);
});

test("a root kernel's sibling send refused as failed asks the chat service to open the root, then sends once more", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reopen-kernel-"));
  const file = join(dir, `${REVIEWER}.jsonl`);
  await writeFile(file, "{}\n");
  const box = daemon(file);
  const reopenCatalog = catalog(file, box);
  const roots: Root[] = [{ sessionId: VP_OF_CI, name: "VP of CI", host: "mac", status: "idle" }, { sessionId: REVIEWER, name: "runner reviewer", host: "mac", status: "idle" }];
  const directory: RootDirectory = { roots: () => roots, send: async () => { throw new Error("not a cross-host send"); }, reopen: id => reopenSession(reopenCatalog, { agentDir: dir }, id) };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const { from, to } = JSON.parse(body) as { from: string; to: string };
      const answer = req.url!.endsWith("api/agent/reopen") ? reopenSibling(directory, from, to) : Promise.reject(new Error(`unexpected ${req.url}`));
      answer.then(value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
        error => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  // The kernel's own daemon: the send fails until the chat service's create has opened the root.
  await writeFile(join(dir, "rlm.py"), [
    "import os",
    "SENDS = []",
    "async def host_request(request_type, payload=None):",
    "    SENDS.append(payload['receiver_name'])",
    `    if not os.path.exists(${JSON.stringify(join(dir, "opened"))}):`,
    `        raise RuntimeError('${FAILED}')`,
    "    return {'deliveryStatus': 'delivered', 'sends': len(SENDS)}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, agent_message",
    "async def main():",
    "    try:",
    "        out = await agent_message.host_request('agent_message.send', {'message': 'review d789534318', 'receiver_role': 'sibling', 'receiver_name': 'runner reviewer'})",
    "    except Exception as error:",
    "        out = {'error': str(error)}",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  const kernel = async () => {
    const sessionDir = join(dir, "session-artifacts", VP_OF_CI);
    await mkdir(sessionDir, { recursive: true });
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json") } });
    return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
  };
  // The create marks the root open for the fake kernel daemon.
  const create = box.client.request.bind(box.client);
  box.client.request = async command => {
    const answer = await create(command);
    if (command.type === "create" && answer.success) await writeFile(join(dir, "opened"), "");
    return answer;
  };
  try {
    assert.deepEqual(await kernel(), { deliveryStatus: "delivered", sends: 2 });
    assert.deepEqual(box.requests, [{ type: "create", lifecycle: "resident", sessionPath: file }]);
  } finally { server.close(); }
});
