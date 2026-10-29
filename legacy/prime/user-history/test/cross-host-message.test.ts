// Guards the 10-18 host move: from 03:20Z every agent_message.send from a us-metal02 chat to a root still on the Mac (Fable, the release owner,
// the AI harness chat, ops guy) failed with 'No sibling matches', since each daemon finds siblings only among its own roots, and land 37
// missed Fable's rerun before its 05:14Z deadline.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { otherBoxRoots, pickRoot, type Root, type RootDirectory, rootsOf, sendCrossHost, siblingRow } from "../src/cross-host-message.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const VP = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const RELEASE_OWNER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const ROOTS: Root[] = [
  { sessionId: VP, activeSessionId: "e61370c1f209", name: "***launch main bro***", host: "us-metal02", status: "idle" },
  { sessionId: "01a1180e-0000-7000-8000-000000000000", name: "VP of CI", host: "us-metal02", status: "idle" },
  { sessionId: RELEASE_OWNER, name: "release driver", host: "mac", status: "working" },
  { sessionId: "01a0cc5e-0ca4-762a-90e6-566c310bd50a", name: "Untitled", host: "mac", status: "working" },
];

/** The two boxes as the chat service sees them; each send_message lands in `sent` with the box whose daemon took it. */
function boxes(): RootDirectory & { sent: { host: string; session: string; text: string }[] } {
  const sent: { host: string; session: string; text: string }[] = [];
  return { sent, roots: () => ROOTS, send: async (session, text) => {
    sent.push({ host: ROOTS.find(root => root.sessionId === session)!.host, session, text });
    return { deliveryStatus: "queued", target: { sessionId: session } };
  }, reopen: async () => false };
}

test("a box chat's send to the release owner on the Mac goes to the Mac's daemon with the sender named", async () => {
  const directory = boxes();
  const receipt = await sendCrossHost(directory, VP, "01a10810", "land 37 is green, promote when ready");
  assert.deepEqual([receipt.host, receipt.crossHost, receipt.deliveryStatus], ["mac", true, "queued"]);
  assert.equal(directory.sent.length, 1);
  assert.deepEqual([directory.sent[0]!.host, directory.sent[0]!.session], ["mac", RELEASE_OWNER]);
  assert.ok(directory.sent[0]!.text.startsWith(`[cross-host message from ***launch main bro*** (${VP}) on us-metal02; answer with agent_message.send(`));
  assert.ok(directory.sent[0]!.text.endsWith("\n\nland 37 is green, promote when ready"));
  await assert.rejects(sendCrossHost(directory, VP, "VP of CI", "x"), /No sibling matches "VP of CI" on any box/, "a root on the sender's own box is the daemon's to find");
  assert.deepEqual((await otherBoxRoots(directory, VP)).map(root => root.name), ["release driver", "Untitled"]);
  assert.equal(siblingRow(ROOTS[2]!).relationship, "sibling");
  assert.ok("error" in pickRoot([...ROOTS, { ...ROOTS[3]!, sessionId: "01a0cc5e-ffff-7000-8000-000000000000" }], "untitled"), "two roots of one name need an id");
});

// On 10-21 from 08:33Z every send from a us-metal02 session to slack green guy read 'No sibling matches "slack green guy" on any box either',
// since the Mac's daemon listed that chat archived between the chat service's unarchives and the directory left out every archived root.
test("a chat the Mac's daemon lists archived stays a sibling, and an archived root that is no chat takes a send by name or id", async () => {
  const SLACK_GREEN = "01a11b0b-7c15-73da-9481-8de15903eab4";
  const OLD_JOB = "01a14b74-8945-75a0-9848-36b7e352f66d";
  const roots = rootsOf([
    { sessionId: VP, activeSessionId: "e61370c1f209", name: "***launch main bro***", host: "us-metal02", status: "idle", lifecycle: "live" },
    { sessionId: SLACK_GREEN, name: "slack green guy", host: "mac", status: "idle", lifecycle: "archived" },
    { sessionId: OLD_JOB, name: "land 37 driver", host: "mac", status: "idle", lifecycle: "archived" },
    { sessionId: OLD_JOB, name: "land 37 driver", host: "us-metal02", status: "idle", lifecycle: "live" },
  ], new Set([VP, SLACK_GREEN]));
  assert.equal(roots.length, 3, "a session id two boxes list is one root, the first row's");
  const sent: string[] = [];
  const directory: RootDirectory = { roots: () => roots, reopen: async () => false,
    send: async session => { sent.push(session); return { deliveryStatus: "queued", target: { sessionId: session } }; } };
  assert.deepEqual((await otherBoxRoots(directory, VP)).map(root => root.name), ["slack green guy"]);
  assert.equal((await sendCrossHost(directory, VP, "slack green guy", "delayed check-in report")).host, "mac");
  const archived: Root[] = [{ sessionId: OLD_JOB, name: "land 37 driver", host: "mac", status: "idle", archived: true }];
  const old: RootDirectory = { ...directory, roots: () => [roots[0]!, ...archived] };
  assert.deepEqual(await otherBoxRoots(old, VP), [], "an archived root that is no chat stays off the roster");
  await sendCrossHost(old, VP, "land 37 driver", "x");
  await sendCrossHost(old, VP, OLD_JOB.slice(0, 8), "y");
  assert.deepEqual(sent, [SLACK_GREEN, OLD_JOB, OLD_JOB]);
  const live: Root = { sessionId: "01a15000-0000-7000-8000-000000000000", name: "land 37 driver", host: "mac", status: "idle" };
  assert.equal((pickRoot([...archived, live], "land 37 driver") as Root).sessionId, live.sessionId, "a listed root wins over an archived one of its name");
});

test("in a root's kernel agent_message.send and list_agents reach the Mac through the chat service; a subagent keeps the daemon's error", async () => {
  const directory = boxes();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const answer = url.pathname.endsWith("api/agent/siblings")
        ? otherBoxRoots(directory, url.searchParams.get("session")!).then(roots => ({ agents: roots.map(siblingRow) }))
        : (() => { const { from, to, message } = JSON.parse(body); return sendCrossHost(directory, from, to, message); })();
      answer.then(value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
        error => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "cross-host-"));
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  await writeFile(join(dir, "rlm.py"), [
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_message.send':",
    "        raise RuntimeError('No sibling matches \"' + payload['receiver_name'] + '\"')",
    `    return {'agents': [{'sessionId': '${ROOTS[1]!.sessionId}', 'sessionName': 'VP of CI', 'relationship': 'sibling'}]}`,
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, agent_message, agent_observe",
    "async def main():",
    "    out = {'roster': [a['sessionName'] for a in (await agent_observe.host_request('agent_observe.list'))['agents']]}",
    "    try:",
    `        out['receipt'] = await agent_message.host_request('agent_message.send', {'message': 'rerun land 37', 'receiver_role': 'sibling', 'receiver_name': '${RELEASE_OWNER}'})`,
    "    except Exception as error:",
    "        out['error'] = str(error)",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  const kernel = async (sessionDir: string) => {
    await mkdir(sessionDir, { recursive: true });
    // Async, since this process serves the chat service the kernel calls.
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json"),
        PI_HOST_SOCKET: join(dir, "no-pi-host.sock"), PI_AGENT_BUS_BOXES: join(dir, "no-boxes.json") } });
    return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  };
  try {
    const root = await kernel(join(dir, "session-artifacts", VP));
    assert.deepEqual(root.roster, ["VP of CI", "release driver", "Untitled"]);
    assert.deepEqual([root.receipt.host, root.receipt.deliveryStatus, root.error], ["mac", "queued", undefined]);
    assert.deepEqual(directory.sent.map(sent => [sent.host, sent.session]), [["mac", RELEASE_OWNER]]);
    assert.match(directory.sent[0]!.text, /rerun land 37$/);
    const job = await kernel(join(dir, "session-artifacts", VP, "sub-dc84da03"));
    assert.deepEqual(job.roster, ["VP of CI"]);
    assert.equal(job.error, `No sibling matches "${RELEASE_OWNER}"`);
    assert.equal(directory.sent.length, 1);
  } finally { server.close(); }
});
